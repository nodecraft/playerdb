import { writeDataPoint } from './analytics';
import * as helperCodes from './helpers';
import { errorCode, failCode } from './helpers';

import type { Environment, HonoEnv } from '../types';
import type { HytaleTokenManager } from './hytale-token-manager';
import type { Context } from 'hono';

const ACCOUNT_DATA_URL = 'https://account-data.hytale.com';

const oneDay = 60 * 60 * 24;
const kvCacheTtl = oneDay * 10; // 10 days for KV
const cacheTtl = oneDay * 5; // 5 days for edge/response

const responseHeaders = {
	'content-type': 'application/json; charset=utf-8',
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, OPTIONS',
	'Cache-Control': `public, max-age=${cacheTtl}`,
} as const;

type RequestData = {
	url: string;
	headers?: Record<string, string>;
};

/**
 * Check HTTP status code and throw appropriate error
 */
function handleStatusCode(statusCode: number, context: string): void {
	if (statusCode === 401 || statusCode === 403) {
		const err = new errorCode('hytale.auth_failure', { statusCode });
		(err as any).isAuthError = true;
		throw err;
	}

	if (statusCode === 429) {
		const err = new errorCode('hytale.rate_limited', { statusCode: 429 });
		(err as any).statusCode = 429;
		throw err;
	}

	if (statusCode === 404) {
		throw new failCode('hytale.not_found');
	}

	if (statusCode !== 200) {
		console.log(`[Hytale] ${context} got non-200 response:`, statusCode);
		throw new errorCode('hytale.api_failure');
	}
}

/**
 * Check if a string is a UUID format
 */
function isUuid(query: string): boolean {
	const uuidRegex = /^[\da-f]{8}(?:-?[\da-f]{4}){3}-?[\da-f]{12}$/i;
	return uuidRegex.test(query);
}

const helpers = {
	/**
	 * Final fallback: hit Nodecraft's internal controller API
	 * Used when both direct HTTP and container proxy are rate-limited
	 */
	async nodecraftAPIRequest(
		query: string,
		sessionToken: string,
		env: Environment,
	): Promise<any> {
		const url = new URL('/v2/playerdb', 'https://api.nodecraft.com');
		url.searchParams.set('type', 'hytale');
		url.searchParams.set('api_key', env.NODECRAFT_API_KEY ?? '');
		url.searchParams.set('session_token', sessionToken);

		if (isUuid(query)) {
			url.searchParams.set('id', query);
		} else {
			url.searchParams.set('username', query);
		}

		let response;
		try {
			response = await fetch(url.href, {
				headers: {
					'content-type': 'application/json',
					'accept': 'application/json',
				},
				method: 'GET',
				cf: {
					cacheEverything: true,
					cacheTtl,
				},
				signal: AbortSignal.timeout(5000),
			});
		} catch (err) {
			console.error('[Hytale] Nodecraft API request failed:', err);
			throw new errorCode('hytale.api_failure');
		}

		if (response.status === 429) {
			throw new errorCode('hytale.rate_limited', { statusCode: 429 });
		}

		if (response.status === 404) {
			throw new failCode('hytale.not_found');
		}

		if (response.status !== 200) {
			console.log('[Hytale] Got non-200 from Nodecraft API:', response.status);
			throw new errorCode('hytale.api_failure');
		}

		const contentType = response.headers.get('content-type');
		if (!contentType || !contentType.includes('json')) {
			throw new errorCode('hytale.non_json', { contentType: contentType ?? null });
		}

		let body = null;
		try {
			body = await response.json<any>();
		} catch {
			// we tried
		}

		if (!body) {
			throw new failCode('hytale.not_found');
		}

		return body;
	},

	async request(data: RequestData) {
		const fetchOptions: RequestInit = {
			method: 'GET',
			headers: {
				'User-Agent': 'PlayerDB (+https://playerdb.co)',
				...data.headers,
			},
			signal: AbortSignal.timeout(10000),
			cf: {
				cacheEverything: true,
				cacheTtl,
			},
		};

		let response;
		try {
			response = await fetch(data.url, fetchOptions);
		} catch (err) {
			console.error('Hytale API request failed:', err);
			throw new errorCode('hytale.api_failure');
		}

		handleStatusCode(response.status, 'HTTP request');

		const contentType = response.headers.get('content-type');
		if (!contentType || !contentType.includes('json')) {
			throw new errorCode('hytale.non_json', {
				contentType: contentType ?? null,
			});
		}

		let body = null;
		try {
			body = await response.json<any>();
		} catch (parseErr) {
			console.error('[Hytale] Failed to parse HTTP response JSON:', parseErr);
			throw new errorCode('hytale.api_failure', { message: 'Invalid JSON in API response' });
		}
		if (!body) {
			throw new failCode('hytale.not_found');
		}
		return body;
	},

	/**
	 * Parse the Hytale API response into the standard player format
	 */
	parse(data: any): Record<string, any> {
		let skin = null;
		try {
			skin = JSON.parse(data.skin);
		} catch {
			// we tried
		}
		return {
			id: data.uuid,
			raw_id: data.uuid.replaceAll('-', ''),
			username: data.username,
			avatar: `https://crafthead.net/hytale/avatar/${data.uuid}`,
			skin,
			meta: {},
		};
	},

	/**
	 * Make a request via the container proxy (bypasses IP-based rate limiting)
	 */
	async containerRequest(env: Environment, data: RequestData): Promise<any> {
		const { getRandom } = await import('@cloudflare/containers');
		const container = await getRandom(env.HYTALE_PROXY, 3); // Pick from up to 3 instances

		let response;
		try {
			response = await container.fetch(new Request('http://container/proxy', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ url: data.url, headers: data.headers }),
				signal: AbortSignal.timeout(10000),
			}));
		} catch (err) {
			console.error('[Hytale] Container request failed:', err);
			throw new errorCode('hytale.api_failure');
		}

		handleStatusCode(response.status, 'Container proxy');

		const contentType = response.headers.get('content-type');
		if (!contentType || !contentType.includes('json')) {
			throw new errorCode('hytale.non_json', {
				contentType: contentType ?? null,
			});
		}

		let body = null;
		try {
			body = await response.json<any>();
		} catch (parseErr) {
			console.error('[Hytale] Failed to parse container response JSON:', parseErr);
			throw new errorCode('hytale.api_failure', { message: 'Invalid JSON in API response' });
		}
		if (!body) {
			throw new failCode('hytale.not_found');
		}
		return body;
	},
};

/**
 * Get the Durable Object stub for token management
 * Uses a singleton ID since we only need one token manager
 */
function getTokenManager(env: Environment): DurableObjectStub<HytaleTokenManager> {
	const id = env.HYTALE_TOKEN_MANAGER.idFromName('singleton');
	return env.HYTALE_TOKEN_MANAGER.get(id);
}

/**
 * Validate a Hytale player identifier
 * Accepts:
 * - Usernames: 3-16 alphanumeric characters with underscores
 * - UUIDs: standard UUID format (with or without dashes)
 */
function isValidIdentifier(query: string): boolean {
	const usernameRegex = /^\w{3,16}$/;
	const uuidRegex = /^[\da-f]{8}(?:-?[\da-f]{4}){3}-?[\da-f]{12}$/i;

	return usernameRegex.test(query) || uuidRegex.test(query);
}

/**
 * Check if error should be rethrown without container fallback
 */
function shouldSkipContainerFallback(err: any): boolean {
	const code = err?.code;
	return code === 'hytale.not_found'
		|| code === 'hytale.invalid_identifier'
		|| err?.isAuthError;
}

/**
 * Report rate limit errors to the token manager
 */
function maybeReportRateLimit(
	err: any,
	sessionToken: string,
	tokenManager: DurableObjectStub<HytaleTokenManager>,
	ctx: ExecutionContext,
): void {
	if (err?.statusCode === 429) {
		ctx.waitUntil(tokenManager.reportRateLimit(sessionToken));
	}
}

/**
 * Fetch profile from Hytale API
 * Tries HTTP first, falls back to container proxy for rate limit bypass
 */
async function fetchProfileFromApi(
	query: string,
	sessionToken: string,
	env: Environment,
	tokenManager: DurableObjectStub<HytaleTokenManager>,
	ctx: ExecutionContext,
): Promise<{ data: Record<string, any>; request_type: string; }> {
	const path = isUuid(query)
		? `/profile/uuid/${encodeURIComponent(query)}`
		: `/profile/username/${encodeURIComponent(query)}`;

	const url = `${ACCOUNT_DATA_URL}${path}`;
	const headers = { Authorization: `Bearer ${sessionToken}` };

	let apiResponse;
	let requestType = 'http';

	// 1. Try direct HTTP first
	try {
		console.log('[Hytale] Trying HTTP request');
		apiResponse = await helpers.request({ url, headers });
	} catch (httpErr: any) {
		// Don't retry auth errors, not found, or invalid identifier
		if (shouldSkipContainerFallback(httpErr)) {
			maybeReportRateLimit(httpErr, sessionToken, tokenManager, ctx);
			throw httpErr;
		}

		console.log('[Hytale] HTTP failed, trying container proxy:', httpErr?.message || httpErr);

		// 2. Fall back to container proxy
		try {
			apiResponse = await helpers.containerRequest(env, { url, headers });
			requestType = 'container';
		} catch (containerErr: any) {
			maybeReportRateLimit(containerErr, sessionToken, tokenManager, ctx);
			throw containerErr;
		}
	}

	console.log('[Hytale] Raw API response (%s):', requestType, JSON.stringify(apiResponse, null, 2));

	const data = helpers.parse(apiResponse);
	data.meta ??= {};
	data.meta.cached_at = Math.round(Date.now() / 1000);

	return { data, request_type: requestType };
}

async function getProfile(
	query: string,
	env: Environment,
	ctx: ExecutionContext,
): Promise<{ data: Record<string, any>; request_type: string; }> {
	const kvKey = 'hytale-profile-' + query.toLowerCase();
	console.log('[Hytale] Looking up profile:', query);

	try {
		if (env.BYPASS_CACHE !== 'true') {
			const cached = await env.PLAYERDB_CACHE.get(kvKey, {
				type: 'json',
				cacheTtl: oneDay,
			});
			if (cached) {
				console.log('[Hytale] Profile found in KV cache');
				return { data: cached as Record<string, any>, request_type: 'kv_cache' };
			}
		}
	} catch {
		// KV lookup failed, continue with API
	}

	// Validate the identifier format
	if (!isValidIdentifier(query)) {
		console.log('[Hytale] Invalid identifier format:', query);
		throw new failCode('hytale.invalid_identifier');
	}

	const tokenManager = getTokenManager(env);
	let returnData: Record<string, any>;

	// First attempt with cached token
	let request_type: string;
	try {
		console.log('[Hytale] Fetching profile from API');
		const sessionToken = await tokenManager.getSessionToken();
		const result = await fetchProfileFromApi(query, sessionToken, env, tokenManager, ctx);
		returnData = result.data;
		request_type = result.request_type;
	} catch (err: any) {
		// If auth error, invalidate tokens and retry with fresh ones
		if (err?.isAuthError) {
			console.log('[Hytale] Auth error, invalidating tokens and retrying');
			await tokenManager.invalidateTokens();
			const freshToken = await tokenManager.getSessionToken(true);
			const result = await fetchProfileFromApi(query, freshToken, env, tokenManager, ctx);
			returnData = result.data;
			request_type = result.request_type;
		} else if (err?.code === 'hytale.rate_limited' || err?.message?.includes('rate limited')) {
			// All sessions are rate-limited from worker's IP, try container fallback
			// Rate limiting is IP-based, so container (different IP) might work
			console.log('[Hytale] All sessions rate-limited, trying container fallback');
			const containerToken = await tokenManager.getSessionTokenForContainer();
			const path = isUuid(query)
				? `/profile/uuid/${encodeURIComponent(query)}`
				: `/profile/username/${encodeURIComponent(query)}`;
			const url = `${ACCOUNT_DATA_URL}${path}`;
			const headers = { Authorization: `Bearer ${containerToken}` };

			try {
				const apiResponse = await helpers.containerRequest(env, { url, headers });
				console.log('[Hytale] Container fallback response:', JSON.stringify(apiResponse, null, 2));

				returnData = helpers.parse(apiResponse);
				returnData.meta ??= {};
				returnData.meta.cached_at = Math.round(Date.now() / 1000);
				request_type = 'container_fallback';
			} catch (containerErr: any) {
				// Container also rate-limited, final fallback to Nodecraft API
				if (containerErr?.code === 'hytale.rate_limited' || containerErr?.statusCode === 429) {
					console.log('[Hytale] Container also rate-limited, trying Nodecraft API fallback');
					const apiResponse = await helpers.nodecraftAPIRequest(query, containerToken, env);
					console.log('[Hytale] Nodecraft API fallback response:', JSON.stringify(apiResponse, null, 2));

					returnData = helpers.parse(apiResponse);
					returnData.meta ??= {};
					returnData.meta.cached_at = Math.round(Date.now() / 1000);
					request_type = 'nodecraft_api';
				} else {
					throw containerErr;
				}
			}
		} else {
			throw err;
		}
	}

	console.log('[Hytale] Profile fetched successfully:', returnData.username, '(', returnData.id, ')');

	// Cache the result by original query
	ctx.waitUntil(
		env.PLAYERDB_CACHE.put(kvKey, JSON.stringify(returnData), {
			expirationTtl: kvCacheTtl,
		}),
	);

	// Also cache by player UUID if different from query
	if (returnData.id) {
		const idKey = 'hytale-profile-' + returnData.id.toLowerCase();
		if (idKey !== kvKey) {
			ctx.waitUntil(
				env.PLAYERDB_CACHE.put(idKey, JSON.stringify(returnData), {
					expirationTtl: kvCacheTtl,
				}),
			);
		}
	}

	// Also cache by username if different from query
	if (returnData.username) {
		const usernameKey = 'hytale-profile-' + returnData.username.toLowerCase();
		if (usernameKey !== kvKey) {
			ctx.waitUntil(
				env.PLAYERDB_CACHE.put(usernameKey, JSON.stringify(returnData), {
					expirationTtl: kvCacheTtl,
				}),
			);
		}
	}

	return { data: returnData, request_type };
}

const lookup = async function lookup(honoCtx: Context<HonoEnv>) {
	const env = honoCtx.env;
	const ctx = honoCtx.executionCtx as ExecutionContext;

	const query = honoCtx.get('lookupQuery') || '';

	if (query === '') {
		throw new failCode('api.404');
	}

	const { data: returnData, request_type } = await getProfile(query, env, ctx);

	writeDataPoint(honoCtx, {
		type: 'hytale',
		request_type,
		status: 200,
	});

	const responseFull = helperCodes.code('player.found', { player: returnData }) as Record<
		string,
		unknown
	>;
	responseFull.success = true;

	return honoCtx.json(responseFull, 200, responseHeaders);
};

export default lookup;
