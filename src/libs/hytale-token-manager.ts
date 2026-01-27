import { DurableObject } from 'cloudflare:workers';

import { errorCode } from './helpers';

import type { ContentfulStatusCode } from 'hono/utils/http-status';

// Hytale OAuth and API URLs
const OAUTH_BASE_URL = 'https://oauth.accounts.hytale.com';
const ACCOUNT_DATA_URL = 'https://account-data.hytale.com';
const SESSIONS_URL = 'https://sessions.hytale.com';
const CLIENT_ID = 'hytale-server';

const FIVE_MINUTES = 5 * 60 * 1000;
const SESSION_RATE_LIMIT_COOLDOWN = 60 * 1000; // 60 seconds cooldown for rate-limited sessions
const POOL_SHRINK_DELAY = 10 * 60 * 1000; // 10 minutes without rate limits before shrinking

interface TokenManagerEnv {
	HYTALE_REFRESH_TOKEN?: string;
	HYTALE_PROFILE_UUID?: string;
	HYTALE_SESSION_POOL_MIN?: string;
	HYTALE_SESSION_POOL_MAX?: string;
}

interface SessionInfo {
	sessionToken: string;
	identityToken: string;
	expiresAt: number;
	rateLimitedUntil?: number;
}

interface StoredTokens {
	refreshToken?: string;
	refreshTokenRotatedAt?: number;
	accessToken?: string;
	accessTokenExpiresAt?: number;
	profileUuid?: string;

	// Legacy single session fields (for migration)
	sessionToken?: string;
	identityToken?: string;
	identityTokenExpiresAt?: number;

	// Session pool
	sessions?: SessionInfo[];
	nextSessionIndex?: number;
	lastRateLimitSeen?: number;
}

/**
 * Durable Object for managing Hytale OAuth tokens
 * Uses blockConcurrencyWhile to ensure only one refresh/session creation happens at a time
 */
export class HytaleTokenManager extends DurableObject<TokenManagerEnv> {
	private tokens: StoredTokens | null = null;

	/**
	 * Load tokens from durable storage
	 */
	private async loadTokens(): Promise<StoredTokens> {
		if (!this.tokens) {
			this.tokens = (await this.ctx.storage.get<StoredTokens>('tokens')) || {};
		}
		return this.tokens;
	}

	/**
	 * Save tokens to durable storage
	 */
	private async saveTokens(): Promise<void> {
		if (this.tokens) {
			await this.ctx.storage.put('tokens', this.tokens);
		}
	}

	/**
	 * Check if access token is valid (not expired or expiring soon)
	 */
	private isAccessTokenValid(tokens: StoredTokens): boolean {
		if (!tokens.accessToken || !tokens.accessTokenExpiresAt) {
			return false;
		}
		return (Date.now() + FIVE_MINUTES) < tokens.accessTokenExpiresAt;
	}

	/**
	 * Check if session token is valid (not expired or expiring soon)
	 * @deprecated Use isSessionInfoValid for pool sessions
	 */
	private isSessionTokenValid(tokens: StoredTokens): boolean {
		if (!tokens.sessionToken || !tokens.identityTokenExpiresAt) {
			return false;
		}
		return (Date.now() + FIVE_MINUTES) < tokens.identityTokenExpiresAt;
	}

	/**
	 * Check if a session info object is valid (not expired or expiring soon)
	 */
	private isSessionInfoValid(session: SessionInfo): boolean {
		return (Date.now() + FIVE_MINUTES) < session.expiresAt;
	}

	/**
	 * Check if a session is available (valid and not rate-limited)
	 */
	private isSessionAvailable(session: SessionInfo): boolean {
		if (!this.isSessionInfoValid(session)) {
			return false;
		}
		if (session.rateLimitedUntil && session.rateLimitedUntil > Date.now()) {
			return false;
		}
		return true;
	}

	/**
	 * Parse session expiry timestamp or use default 24-hour TTL
	 */
	private parseSessionExpiry(expiresAt?: string): number {
		if (expiresAt) {
			return new Date(expiresAt).getTime();
		}
		return Date.now() + (24 * 60 * 60 * 1000);
	}

	/**
	 * Create a new session info object (handles access token, profile UUID, and session creation)
	 */
	private async createSessionInfo(): Promise<SessionInfo> {
		const accessToken = await this.refreshAccessToken(false);
		const profileUuid = await this.getProfileUuid(accessToken);
		const sessionData = await this.createNewSession(accessToken, profileUuid);

		return {
			sessionToken: sessionData.sessionToken,
			identityToken: sessionData.identityToken,
			expiresAt: this.parseSessionExpiry(sessionData.expiresAt),
		};
	}

	/**
	 * Parse pool size from env var with validation
	 */
	private parsePoolSize(envValue: string | undefined, defaultValue: number): number {
		if (!envValue) {
			return defaultValue;
		}
		const parsed = Number.parseInt(envValue, 10);
		if (Number.isNaN(parsed) || parsed < 1) {
			return defaultValue;
		}
		return parsed;
	}

	/**
	 * Get the minimum pool size from env or default
	 */
	private getMinPoolSize(): number {
		return this.parsePoolSize(this.env.HYTALE_SESSION_POOL_MIN, 1);
	}

	/**
	 * Get the maximum pool size from env or default
	 */
	private getMaxPoolSize(): number {
		return this.parsePoolSize(this.env.HYTALE_SESSION_POOL_MAX, 10);
	}

	/**
	 * Make HTTP request to Hytale API
	 */
	private async request(options: {
		url: string;
		method?: 'GET' | 'POST';
		headers?: Record<string, string>;
		formBody?: Record<string, string>;
		jsonBody?: Record<string, unknown>;
	}): Promise<any> {
		const fetchOptions: RequestInit = {
			method: options.method || 'GET',
			headers: {
				'User-Agent': 'PlayerDB (+https://playerdb.co)',
				...options.headers,
			},
		};

		if (options.formBody) {
			fetchOptions.headers = {
				...fetchOptions.headers,
				'Content-Type': 'application/x-www-form-urlencoded',
			};
			fetchOptions.body = new URLSearchParams(options.formBody).toString();
		} else if (options.jsonBody) {
			fetchOptions.headers = {
				...fetchOptions.headers,
				'Content-Type': 'application/json',
			};
			fetchOptions.body = JSON.stringify(options.jsonBody);
		}

		const response = await fetch(options.url, fetchOptions);

		if (response.status === 401 || response.status === 403) {
			throw new errorCode('hytale.auth_failure', { statusCode: response.status });
		}

		if (response.status !== 200) {
			throw new errorCode('hytale.api_failure', { statusCode: response.status as ContentfulStatusCode });
		}

		return response.json();
	}

	/**
	 * Get the current refresh token (from storage or env)
	 */
	private async getRefreshToken(): Promise<string> {
		const tokens = await this.loadTokens();

		// Prefer stored (potentially rotated) refresh token
		if (tokens.refreshToken) {
			console.log('[Hytale] Using stored refresh token');
			return tokens.refreshToken;
		}

		// Fall back to env var
		if (!this.env.HYTALE_REFRESH_TOKEN) {
			console.log('[Hytale] No refresh token available');
			throw new errorCode('hytale.no_refresh_token');
		}

		console.log('[Hytale] Using env var refresh token');
		return this.env.HYTALE_REFRESH_TOKEN;
	}

	/**
	 * Perform the actual access token refresh (called within blockConcurrencyWhile)
	 */
	private async doRefreshAccessToken(): Promise<string> {
		const tokens = await this.loadTokens();
		const refreshToken = await this.getRefreshToken();

		let tokenResponse;
		try {
			tokenResponse = await this.request({
				url: `${OAUTH_BASE_URL}/oauth2/token`,
				method: 'POST',
				formBody: {
					client_id: CLIENT_ID,
					grant_type: 'refresh_token',
					refresh_token: refreshToken,
				},
			});
		} catch (err) {
			// If refresh failed and we were using a stored token, clear it
			// so next attempt falls back to env var (allows recovery)
			console.log('[Hytale] Access token refresh failed:', err);
			if (tokens.refreshToken) {
				console.log('[Hytale] Clearing stored refresh token to allow recovery via env var');
				tokens.refreshToken = undefined;
				tokens.refreshTokenRotatedAt = undefined;
				await this.saveTokens();
			}
			throw err;
		}

		if (!tokenResponse.access_token) {
			throw new errorCode('hytale.token_refresh_failed');
		}

		const now = Date.now();
		const expiresInMs = (tokenResponse.expires_in || 3600) * 1000;

		tokens.accessToken = tokenResponse.access_token;
		tokens.accessTokenExpiresAt = now + expiresInMs;

		// Handle refresh token rotation
		if (tokenResponse.refresh_token && tokenResponse.refresh_token !== refreshToken) {
			console.log('[Hytale] Refresh token rotated, storing new token');
			tokens.refreshToken = tokenResponse.refresh_token;
			tokens.refreshTokenRotatedAt = now;
		}

		// Track initial rotation time if not set
		if (!tokens.refreshTokenRotatedAt) {
			tokens.refreshTokenRotatedAt = now;
		}

		await this.saveTokens();
		console.log('[Hytale] Access token refreshed, expires in', Math.round(expiresInMs / 60000), 'min');

		if (!tokens.accessToken) {
			throw new errorCode('hytale.token_refresh_failed');
		}
		return tokens.accessToken;
	}

	/**
	 * Refresh the OAuth access token
	 * Uses blockConcurrencyWhile to ensure only one refresh at a time
	 */
	private async refreshAccessToken(force: boolean = false): Promise<string> {
		const tokens = await this.loadTokens();

		// Fast path: return cached token if still valid (no blocking needed)
		if (!force && this.isAccessTokenValid(tokens)) {
			console.log('[Hytale] Using cached access token (valid for', Math.round((tokens.accessTokenExpiresAt! - Date.now()) / 60000), 'min)');
			return tokens.accessToken!;
		}

		console.log('[Hytale] Access token refresh needed (force:', force, ')');

		// Block concurrent requests during refresh
		return this.ctx.blockConcurrencyWhile(async () => {
			// Re-check after acquiring lock (another request may have refreshed while we waited)
			const tokens = await this.loadTokens();
			if (!force && this.isAccessTokenValid(tokens)) {
				console.log('[Hytale] Access token refreshed by another request while waiting');
				return tokens.accessToken!;
			}

			console.log('[Hytale] Performing access token refresh');
			return this.doRefreshAccessToken();
		});
	}

	/**
	 * Get profile UUID (from env, storage, or API)
	 */
	private async getProfileUuid(accessToken: string): Promise<string> {
		// Use env var if configured
		if (this.env.HYTALE_PROFILE_UUID) {
			console.log('[Hytale] Using profile UUID from env var');
			return this.env.HYTALE_PROFILE_UUID;
		}

		const tokens = await this.loadTokens();

		// Use cached UUID
		if (tokens.profileUuid) {
			console.log('[Hytale] Using cached profile UUID');
			return tokens.profileUuid;
		}

		// Fetch from API
		console.log('[Hytale] Fetching profile UUID from API');
		const profileResponse = await this.request({
			url: `${ACCOUNT_DATA_URL}/my-account/get-profiles`,
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		});

		if (!profileResponse.profiles || profileResponse.profiles.length === 0) {
			console.log('[Hytale] No profiles found in account');
			throw new errorCode('hytale.no_profiles');
		}

		tokens.profileUuid = profileResponse.profiles[0].uuid;
		await this.saveTokens();
		console.log('[Hytale] Profile UUID fetched and cached:', tokens.profileUuid);

		if (!tokens.profileUuid) {
			throw new errorCode('hytale.no_profiles');
		}
		return tokens.profileUuid;
	}

	/**
	 * Refresh an existing game session
	 * Returns new session tokens or null if refresh fails
	 */
	private async tryRefreshSession(sessionToken: string): Promise<{
		sessionToken: string;
		identityToken: string;
		expiresAt?: string;
	} | null> {
		console.log('[Hytale] Attempting to refresh existing game session');
		try {
			const response = await this.request({
				url: `${SESSIONS_URL}/game-session/refresh`,
				method: 'POST',
				headers: {
					Authorization: `Bearer ${sessionToken}`,
				},
			});

			if (response.sessionToken && response.identityToken) {
				console.log('[Hytale] Game session refreshed successfully');
				return {
					sessionToken: response.sessionToken,
					identityToken: response.identityToken,
					expiresAt: response.expiresAt,
				};
			}
			console.log('[Hytale] Game session refresh returned incomplete data');
			return null;
		} catch (err) {
			console.log('[Hytale] Game session refresh failed:', err);
			// Session refresh failed, will need to create new session
			return null;
		}
	}

	/**
	 * Create a new game session
	 */
	private async createNewSession(accessToken: string, profileUuid: string): Promise<{
		sessionToken: string;
		identityToken: string;
		expiresAt?: string;
	}> {
		console.log('[Hytale] Creating new game session for profile:', profileUuid);
		const sessionResponse = await this.request({
			url: `${SESSIONS_URL}/game-session/new`,
			method: 'POST',
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
			jsonBody: {
				uuid: profileUuid,
			},
		});

		if (!sessionResponse.sessionToken || !sessionResponse.identityToken) {
			console.log('[Hytale] Game session creation returned incomplete data');
			throw new errorCode('hytale.session_creation_failed');
		}

		console.log('[Hytale] New game session created, expires:', sessionResponse.expiresAt);
		return {
			sessionToken: sessionResponse.sessionToken,
			identityToken: sessionResponse.identityToken,
			expiresAt: sessionResponse.expiresAt,
		};
	}

	/**
	 * Migrate from old single-session format to pool format
	 */
	private async migrateToPoolFormat(tokens: StoredTokens): Promise<void> {
		if (tokens.sessionToken && tokens.identityToken && tokens.identityTokenExpiresAt) {
			console.log('[Hytale] Migrating single session to pool format');
			tokens.sessions = [{
				sessionToken: tokens.sessionToken,
				identityToken: tokens.identityToken,
				expiresAt: tokens.identityTokenExpiresAt,
			}];
			tokens.nextSessionIndex = 0;

			// Clear old fields
			tokens.sessionToken = undefined;
			tokens.identityToken = undefined;
			tokens.identityTokenExpiresAt = undefined;

			await this.saveTokens();
		}
	}

	/**
	 * Ensure the pool has at least minPoolSize valid sessions
	 * First tries to refresh expired sessions, removes them if refresh fails,
	 * then creates new sessions if still below minimum
	 */
	private async ensureMinPool(): Promise<void> {
		const tokens = await this.loadTokens();

		// Migrate from old format if needed
		if (tokens.sessionToken && !tokens.sessions) {
			await this.migrateToPoolFormat(tokens);
		}

		// Initialize pool if doesn't exist
		if (!tokens.sessions) {
			tokens.sessions = [];
			tokens.nextSessionIndex = 0;
		}

		const minSize = this.getMinPoolSize();

		// Count valid sessions
		const validSessions = tokens.sessions.filter(session => this.isSessionInfoValid(session));
		const needed = minSize - validSessions.length;

		if (needed <= 0) {
			return;
		}

		console.log('[Hytale] Pool has', validSessions.length, 'valid sessions, need', needed, 'more');

		// Try to refresh expired sessions and create new ones if needed
		await this.ctx.blockConcurrencyWhile(async () => {
			const tokens = await this.loadTokens();
			if (!tokens.sessions) {
				tokens.sessions = [];
			}

			// Separate valid and expired sessions
			const validSessions: SessionInfo[] = [];
			const expiredSessions: SessionInfo[] = [];

			for (const session of tokens.sessions) {
				if (this.isSessionInfoValid(session)) {
					validSessions.push(session);
				} else {
					expiredSessions.push(session);
				}
			}

			let refreshedCount = 0;
			let removedCount = 0;

			// Try to refresh expired sessions (only as many as needed to reach minimum)
			for (const expired of expiredSessions) {
				// Stop if we already have enough valid sessions
				if (validSessions.length >= minSize) {
					// Remove remaining expired sessions without trying to refresh
					removedCount += expiredSessions.length - refreshedCount - removedCount;
					console.log('[Hytale] Pool at minimum size, removing', removedCount, 'remaining expired sessions');
					break;
				}

				console.log('[Hytale] Attempting to refresh expired session');
				const refreshed = await this.tryRefreshSession(expired.sessionToken);

				if (refreshed) {
					// Refresh succeeded, add to valid sessions
					validSessions.push({
						sessionToken: refreshed.sessionToken,
						identityToken: refreshed.identityToken,
						expiresAt: this.parseSessionExpiry(refreshed.expiresAt),
					});
					refreshedCount++;
					console.log('[Hytale] Expired session refreshed successfully');
				} else {
					// Refresh failed, session will be removed (not added back)
					removedCount++;
					console.log('[Hytale] Expired session refresh failed, removing from pool');
				}
			}

			// Update pool with only valid sessions
			tokens.sessions = validSessions;

			// Check if we still need more sessions
			const stillNeeded = minSize - tokens.sessions.length;

			if (stillNeeded <= 0) {
				tokens.nextSessionIndex = Math.min(tokens.nextSessionIndex ?? 0, tokens.sessions.length - 1);
				await this.saveTokens();
				console.log('[Hytale] Pool has', tokens.sessions.length, 'sessions (refreshed', refreshedCount, ', removed', removedCount, ')');
				return;
			}

			// Create new sessions to reach minimum
			let lastError: Error | null = null;
			let createdCount = 0;

			for (let i = 0; i < stillNeeded; i++) {
				try {
					const sessionInfo = await this.createSessionInfo();
					tokens.sessions.push(sessionInfo);
					createdCount++;
					console.log('[Hytale] Created session', tokens.sessions.length, 'for pool');
				} catch (err) {
					lastError = err instanceof Error ? err : new Error(String(err));
					console.error('[Hytale] Failed to create session for pool:', err);
					break;
				}
			}

			// Reset index if it's now out of bounds
			if (tokens.sessions.length > 0) {
				tokens.nextSessionIndex = Math.min(tokens.nextSessionIndex ?? 0, tokens.sessions.length - 1);
			} else {
				tokens.nextSessionIndex = 0;
			}

			await this.saveTokens();

			// If we created zero sessions and the pool is empty, surface the error
			if (createdCount === 0 && tokens.sessions.length === 0 && lastError) {
				throw new errorCode('hytale.session_creation_failed', {
					message: `Failed to create any sessions for pool: ${lastError.message}`,
				});
			}

			console.log('[Hytale] Pool now has', tokens.sessions.length, 'sessions (refreshed', refreshedCount, ', removed', removedCount, ', created', createdCount, ')');
		});
	}

	/**
	 * Get the next available session using round-robin selection
	 * Skips rate-limited and expired sessions
	 * Uses blockConcurrencyWhile to prevent race conditions in session selection
	 */
	private async getNextSession(): Promise<SessionInfo> {
		// Use blockConcurrencyWhile to prevent race conditions where concurrent
		// requests could select the same session or overwrite each other's index updates
		type SessionResult = { session: SessionInfo; } | { error: 'no_sessions' | 'all_unavailable'; };
		const result: SessionResult = await this.ctx.blockConcurrencyWhile(async () => {
			const tokens = await this.loadTokens();

			if (!tokens.sessions || tokens.sessions.length === 0) {
				return { error: 'no_sessions' as const };
			}

			const poolSize = tokens.sessions.length;
			const startIndex = tokens.nextSessionIndex ?? 0;

			// Try to find an available session starting from nextSessionIndex
			for (let i = 0; i < poolSize; i++) {
				const index = (startIndex + i) % poolSize;
				const session = tokens.sessions[index];
				if (!session) {
					continue;
				}

				if (this.isSessionAvailable(session)) {
					// Update next index for round-robin
					tokens.nextSessionIndex = (index + 1) % poolSize;
					await this.saveTokens();

					console.log('[Hytale] Using session', index + 1, 'of', poolSize);
					return { session };
				}
			}

			// All sessions unavailable
			return { error: 'all_unavailable' as const };
		});

		if ('session' in result) {
			return result.session;
		}

		if (result.error === 'no_sessions') {
			throw new errorCode('hytale.no_sessions');
		}

		// All sessions unavailable, try to expand the pool
		console.log('[Hytale] All sessions unavailable, attempting to expand pool');
		const newSession = await this.expandPool();

		if (newSession) {
			return newSession;
		}

		// Pool at max or expansion failed, throw rate limited error
		console.log('[Hytale] Cannot expand pool, all sessions rate-limited');
		throw new errorCode('hytale.rate_limited', { statusCode: 429 });
	}

	/**
	 * Expand the pool by creating a new session
	 * Returns the new session if successful, null if at max or creation fails
	 */
	private async expandPool(): Promise<SessionInfo | null> {
		return this.ctx.blockConcurrencyWhile(async () => {
			const tokens = await this.loadTokens();
			const maxSize = this.getMaxPoolSize();

			if (!tokens.sessions) {
				tokens.sessions = [];
			}

			if (tokens.sessions.length >= maxSize) {
				console.log('[Hytale] Pool at maximum size (', maxSize, '), cannot expand');
				return null;
			}

			try {
				const newSession = await this.createSessionInfo();
				tokens.sessions.push(newSession);
				await this.saveTokens();

				console.log('[Hytale] Expanded pool to', tokens.sessions.length, 'sessions');
				return newSession;
			} catch (err) {
				console.log('[Hytale] Failed to expand pool:', err);
				return null;
			}
		});
	}

	/**
	 * Shrink the pool back to minimum size if no recent rate limits
	 */
	private async maybeShrinkPool(): Promise<void> {
		const tokens = await this.loadTokens();

		if (!tokens.sessions || tokens.sessions.length <= this.getMinPoolSize()) {
			return;
		}

		const lastRateLimit = tokens.lastRateLimitSeen ?? 0;
		const timeSinceRateLimit = Date.now() - lastRateLimit;

		if (timeSinceRateLimit < POOL_SHRINK_DELAY) {
			console.log('[Hytale] Recent rate limit, not shrinking pool');
			return;
		}

		await this.ctx.blockConcurrencyWhile(async () => {
			const tokens = await this.loadTokens();
			const minSize = this.getMinPoolSize();

			if (!tokens.sessions || tokens.sessions.length <= minSize) {
				return;
			}

			// Keep the first minSize valid sessions, remove the rest
			const validSessions = tokens.sessions.filter(session => this.isSessionInfoValid(session));
			tokens.sessions = validSessions.slice(0, minSize);
			tokens.nextSessionIndex = 0;

			await this.saveTokens();
			console.log('[Hytale] Shrunk pool to', tokens.sessions.length, 'sessions');
		});
	}

	/**
	 * Report that a session received a rate limit (429)
	 * Marks the session as rate-limited and optionally expands the pool
	 */
	async reportRateLimit(sessionToken: string): Promise<void> {
		console.log('[Hytale] Rate limit reported for session');

		await this.ctx.blockConcurrencyWhile(async () => {
			const tokens = await this.loadTokens();

			if (!tokens.sessions) {
				return;
			}

			// Find and mark the session as rate-limited
			const session = tokens.sessions.find(sess => sess.sessionToken === sessionToken);
			if (session) {
				session.rateLimitedUntil = Date.now() + SESSION_RATE_LIMIT_COOLDOWN;
				console.log('[Hytale] Marked session as rate-limited for', SESSION_RATE_LIMIT_COOLDOWN / 1000, 'seconds');
			}

			tokens.lastRateLimitSeen = Date.now();
			await this.saveTokens();
		});

		// Preemptively expand pool
		await this.expandPool();
	}

	/**
	 * Perform the actual session refresh/creation (called within blockConcurrencyWhile)
	 * @deprecated Use pool-based session management instead
	 */
	private async doGetOrRefreshSession(force: boolean): Promise<string> {
		const tokens = await this.loadTokens();
		let sessionData: {
			sessionToken: string;
			identityToken: string;
			expiresAt?: string;
		} | null = null;

		// Try to refresh existing session first (avoids session limits)
		if (tokens.sessionToken && !force) {
			sessionData = await this.tryRefreshSession(tokens.sessionToken);
		}

		// If refresh failed or no existing session, create new one
		if (!sessionData) {
			// Get access token (may refresh OAuth token if needed)
			const accessToken = await this.refreshAccessToken(force);

			// Get profile UUID
			const profileUuid = await this.getProfileUuid(accessToken);

			// Create new session
			sessionData = await this.createNewSession(accessToken, profileUuid);
		}

		// Store session tokens
		tokens.sessionToken = sessionData.sessionToken;
		tokens.identityToken = sessionData.identityToken;

		// Parse expiration or default to 24 hours
		if (sessionData.expiresAt) {
			tokens.identityTokenExpiresAt = new Date(sessionData.expiresAt).getTime();
		} else {
			tokens.identityTokenExpiresAt = Date.now() + (24 * 60 * 60 * 1000);
		}

		await this.saveTokens();

		const expiresInMin = Math.round((tokens.identityTokenExpiresAt - Date.now()) / 60000);
		console.log('[Hytale] Session operation complete, session token expires in', expiresInMin, 'min');

		return tokens.sessionToken;
	}

	/**
	 * Get or refresh a game session token
	 * Tries to refresh existing session first, creates new one if needed
	 * Uses blockConcurrencyWhile to ensure only one session operation at a time
	 * @deprecated
	 */
	private async getOrRefreshSession(force: boolean = false): Promise<string> {
		const tokens = await this.loadTokens();

		// Fast path: return cached session token if still valid (no blocking needed)
		if (!force && this.isSessionTokenValid(tokens)) {
			console.log('[Hytale] Using cached session token (valid for', Math.round((tokens.identityTokenExpiresAt! - Date.now()) / 60000), 'min)');
			return tokens.sessionToken!;
		}

		console.log('[Hytale] Session operation needed (force:', force, ')');

		// Block concurrent requests during session operation
		return this.ctx.blockConcurrencyWhile(async () => {
			// Re-check after acquiring lock (another request may have refreshed while we waited)
			const tokens = await this.loadTokens();
			if (!force && this.isSessionTokenValid(tokens)) {
				console.log('[Hytale] Session refreshed by another request while waiting');
				return tokens.sessionToken!;
			}

			console.log('[Hytale] Performing session operation');
			return this.doGetOrRefreshSession(force);
		});
	}

	/**
	 * Invalidate session/access tokens (called when API returns auth errors)
	 * Preserves refresh token for retry
	 */
	async invalidateTokens(): Promise<void> {
		console.log('[Hytale] Invalidating access/session tokens (preserving refresh token)');
		const tokens = await this.loadTokens();
		tokens.accessToken = undefined;
		tokens.accessTokenExpiresAt = undefined;

		// Clear legacy single session fields
		tokens.sessionToken = undefined;
		tokens.identityToken = undefined;
		tokens.identityTokenExpiresAt = undefined;

		// Clear session pool
		tokens.sessions = undefined;
		tokens.nextSessionIndex = undefined;
		tokens.lastRateLimitSeen = undefined;

		await this.saveTokens();
	}

	/**
	 * Complete reset - clears ALL stored tokens including refresh token
	 * Use this for manual recovery when env vars have been updated
	 * Next request will use fresh env var values
	 */
	async resetAllTokens(): Promise<void> {
		console.log('[Hytale] Resetting ALL tokens (including refresh token)');
		this.tokens = {};
		await this.ctx.storage.delete('tokens');
	}

	/**
	 * Get a valid session token for API calls
	 * This is the main entry point for the worker
	 * Uses the session pool with round-robin selection
	 */
	async getSessionToken(force: boolean = false): Promise<string> {
		console.log('[Hytale] getSessionToken called (force:', force, ')');

		// Ensure we have at least the minimum number of sessions
		await this.ensureMinPool();

		// Get the next available session from the pool
		const session = await this.getNextSession();
		return session.sessionToken;
	}

	/**
	 * Get a valid (non-expired) session token for container fallback
	 * Prefers sessions not marked as rate-limited (in case there's token-level limiting too)
	 * Falls back to rate-limited sessions sorted by oldest rate-limit time
	 */
	async getSessionTokenForContainer(): Promise<string> {
		console.log('[Hytale] getSessionTokenForContainer called');

		const tokens = await this.loadTokens();

		if (!tokens.sessions || tokens.sessions.length === 0) {
			throw new errorCode('hytale.no_sessions');
		}

		const now = Date.now();
		const validSessions = tokens.sessions.filter(session => this.isSessionInfoValid(session));

		if (validSessions.length === 0) {
			throw new errorCode('hytale.no_sessions');
		}

		// Prefer sessions that aren't currently marked as rate-limited
		const notRateLimited = validSessions.filter(session => !session.rateLimitedUntil || session.rateLimitedUntil <= now);
		if (notRateLimited.length > 0) {
			console.log('[Hytale] Found non-rate-limited session for container fallback');
			return notRateLimited[0].sessionToken;
		}

		// All sessions are rate-limited, pick the one whose rate-limit was set longest ago
		// (most time for any token-level rate limit to have cleared)
		const sorted = validSessions.sort((sessionA, sessionB) => (sessionA.rateLimitedUntil ?? 0) - (sessionB.rateLimitedUntil ?? 0));
		console.log('[Hytale] All sessions rate-limited, using oldest for container fallback');
		return sorted[0].sessionToken;
	}

	/**
	 * Proactive refresh token rotation
	 * Called by scheduled handler to ensure refresh token doesn't expire
	 * Refresh tokens have 30-day TTL, we rotate if expiring within 7 days
	 * Also shrinks the session pool if no recent rate limits
	 * Returns status message for logging
	 */
	async proactiveRefresh(): Promise<string> {
		const tokens = await this.loadTokens();

		// Check if we have a refresh token configured
		const hasRefreshToken = tokens.refreshToken || this.env.HYTALE_REFRESH_TOKEN;
		if (!hasRefreshToken) {
			return 'No refresh token configured, skipping';
		}

		const now = Date.now();
		const sevenDays = 7 * 24 * 60 * 60 * 1000;
		const thirtyDays = 30 * 24 * 60 * 60 * 1000;
		const lastRotated = tokens.refreshTokenRotatedAt || 0;

		// Shrink pool if no recent rate limits
		await this.maybeShrinkPool();

		// Check if token is expiring within 7 days (rotated more than 23 days ago)
		const tokenAge = now - lastRotated;
		if (lastRotated > 0 && tokenAge < (thirtyDays - sevenDays)) {
			const ageDays = Math.floor(tokenAge / (24 * 60 * 60 * 1000));
			return `Token still fresh (age: ${ageDays} days), skipping`;
		}

		// Token is old or age unknown, refresh it
		const ageDays = lastRotated > 0 ? Math.floor(tokenAge / (24 * 60 * 60 * 1000)) : 'unknown';

		try {
			await this.refreshAccessToken(true);
			return `Successfully rotated refresh token (previous age: ${ageDays} days)`;
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Unknown error';
			return `Failed to rotate refresh token: ${message}`;
		}
	}
}
