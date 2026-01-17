import { DurableObject } from 'cloudflare:workers';

import { errorCode } from './helpers';

import type { ContentfulStatusCode } from 'hono/utils/http-status';

// Hytale OAuth and API URLs
const OAUTH_BASE_URL = 'https://oauth.accounts.hytale.com';
const ACCOUNT_DATA_URL = 'https://account-data.hytale.com';
const SESSIONS_URL = 'https://sessions.hytale.com';
const CLIENT_ID = 'hytale-server';

const FIVE_MINUTES = 5 * 60 * 1000;

interface TokenManagerEnv {
	HYTALE_REFRESH_TOKEN?: string;
	HYTALE_PROFILE_UUID?: string;
}

interface StoredTokens {
	refreshToken?: string;
	refreshTokenRotatedAt?: number;
	accessToken?: string;
	accessTokenExpiresAt?: number;
	profileUuid?: string;
	sessionToken?: string;
	identityToken?: string;
	identityTokenExpiresAt?: number;
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
	 */
	private isSessionTokenValid(tokens: StoredTokens): boolean {
		if (!tokens.sessionToken || !tokens.identityTokenExpiresAt) {
			return false;
		}
		return (Date.now() + FIVE_MINUTES) < tokens.identityTokenExpiresAt;
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
	 * Perform the actual session refresh/creation (called within blockConcurrencyWhile)
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
		tokens.sessionToken = undefined;
		tokens.identityToken = undefined;
		tokens.identityTokenExpiresAt = undefined;
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
	 */
	async getSessionToken(force: boolean = false): Promise<string> {
		console.log('[Hytale] getSessionToken called (force:', force, ')');
		return this.getOrRefreshSession(force);
	}

	/**
	 * Proactive refresh token rotation
	 * Called by scheduled handler to ensure refresh token doesn't expire
	 * Refresh tokens have 30-day TTL, we rotate if expiring within 7 days
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
