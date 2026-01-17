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

const helpers = {
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

		if (response.status === 401 || response.status === 403) {
			const err = new errorCode('hytale.auth_failure', { statusCode: response.status });
			(err as any).isAuthError = true;
			throw err;
		}

		if (response.status === 429) {
			throw new errorCode('hytale.rate_limited', { statusCode: 429 });
		}

		if (response.status === 404) {
			throw new failCode('hytale.not_found');
		}

		if (response.status !== 200) {
			console.log(
				'Hytale API request failed:',
				response.status,
				response.statusText,
				data.url,
			);
			throw new errorCode('hytale.api_failure');
		}

		const contentType = response.headers.get('content-type');
		if (!contentType || !contentType.includes('json')) {
			throw new errorCode('hytale.non_json', {
				contentType: contentType ?? null,
			});
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
		body.request_type = 'http';
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
 * Check if a string is a UUID format
 */
function isUuid(query: string): boolean {
	const uuidRegex = /^[\da-f]{8}(?:-?[\da-f]{4}){3}-?[\da-f]{12}$/i;
	return uuidRegex.test(query);
}

/**
 * Fetch profile from Hytale API
 */
async function fetchProfileFromApi(
	query: string,
	sessionToken: string,
): Promise<Record<string, any>> {
	const endpoint = isUuid(query)
		? `${ACCOUNT_DATA_URL}/profile/uuid/${encodeURIComponent(query)}`
		: `${ACCOUNT_DATA_URL}/profile/username/${encodeURIComponent(query)}`;

	const apiResponse = await helpers.request({
		url: endpoint,
		headers: {
			Authorization: `Bearer ${sessionToken}`,
		},
	});

	// Debug: log the raw API response
	console.log('[Hytale] Raw API response:', JSON.stringify(apiResponse, null, 2));

	const returnData = helpers.parse(apiResponse);
	returnData.meta ??= {};
	returnData.meta.cached_at = Math.round(Date.now() / 1000);

	return returnData;
}

async function getProfile(
	query: string,
	env: Environment,
	ctx: ExecutionContext,
): Promise<{ data: Record<string, any>; fromCache: boolean; }> {
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
				return { data: cached as Record<string, any>, fromCache: true };
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
	try {
		console.log('[Hytale] Fetching profile from API');
		const sessionToken = await tokenManager.getSessionToken();
		returnData = await fetchProfileFromApi(query, sessionToken);
	} catch (err: any) {
		// If auth error, invalidate tokens and retry with fresh ones
		if (err?.isAuthError) {
			console.log('[Hytale] Auth error, invalidating tokens and retrying');
			await tokenManager.invalidateTokens();
			const freshToken = await tokenManager.getSessionToken(true);
			returnData = await fetchProfileFromApi(query, freshToken);
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

	return { data: returnData, fromCache: false };
}

const lookup = async function lookup(honoCtx: Context<HonoEnv>) {
	const env = honoCtx.env;
	const ctx = honoCtx.executionCtx as ExecutionContext;

	const query = honoCtx.get('lookupQuery') || '';

	if (query === '') {
		throw new failCode('api.404');
	}

	const { data: returnData, fromCache } = await getProfile(query, env, ctx);

	writeDataPoint(honoCtx, {
		type: 'hytale',
		request_type: fromCache ? 'kv_cache' : 'http',
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
