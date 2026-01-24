// eslint-disable-next-line n/no-missing-import
import { connect } from 'cloudflare:sockets';

import { writeDataPoint } from './analytics';
import * as helperCodes from './helpers';
import { errorCode, failCode } from './helpers';
import { parseResponse } from './http';

import type { Environment, HonoEnv } from '../types';
import type { HytaleTokenManager } from './hytale-token-manager';
import type { Context } from 'hono';

const ACCOUNT_DATA_HOST = 'account-data.hytale.com';
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
	 * Make a raw TCP request to Hytale API (bypasses some rate limiting)
	 */
	async tcpRequest(path: string, sessionToken: string): Promise<any> {
		const timeoutMs = 5000;
		let socket: Awaited<ReturnType<typeof connect>> | null = null;
		let timeoutId: ReturnType<typeof setTimeout> | null = null;

		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutId = setTimeout(() => {
				if (socket) {
					try {
						socket.close();
					} catch {
						// Ignore close errors
					}
				}
				reject(new errorCode('hytale.api_failure', { message: 'TCP request timed out' }));
			}, timeoutMs);
		});

		const requestPromise = (async () => {
			socket = await connect(
				{
					hostname: ACCOUNT_DATA_HOST,
					port: 443,
				},
				{
					secureTransport: 'on',
					allowHalfOpen: false,
				},
			);

			const writer = socket.writable.getWriter();
			const encoder = new TextEncoder();
			const rawHTTPReq = [
				`GET ${path} HTTP/1.1`,
				`Host: ${ACCOUNT_DATA_HOST}`,
				'Accept: application/json',
				`Authorization: Bearer ${sessionToken}`,
				'Connection: close',
			];
			const joined = rawHTTPReq.join('\r\n');
			const encoded = encoder.encode(`${joined}\r\n\r\n`);
			await writer.write(encoded);

			const reader = socket.readable.getReader();
			const chunks: Uint8Array[] = [];

			// Collect all chunks
			// eslint-disable-next-line no-constant-condition
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				chunks.push(value);
			}
			socket.close();

			// Calculate total length and concatenate
			const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
			const combined = new Uint8Array(totalLength);
			let offset = 0;
			for (const chunk of chunks) {
				combined.set(chunk, offset);
				offset += chunk.length;
			}

			return new TextDecoder().decode(combined);
		})();

		let result: string;
		try {
			result = await Promise.race([requestPromise, timeoutPromise]);
		} catch (err) {
			// Pass through hytale errors (including timeout)
			// @ts-expect-error error not properly typed
			if (typeof err?.code === 'string' && err.code.startsWith('hytale.')) {
				throw err;
			}
			console.error('[Hytale] TCP error:', err);
			throw new errorCode('hytale.api_failure');
		} finally {
			if (timeoutId) {
				clearTimeout(timeoutId);
			}
		}

		const parsed = parseResponse(result);
		handleStatusCode(parsed.statusCode, 'TCP request');

		const contentType = parsed.headers['content-type'];
		if (!contentType || !contentType.includes('json')) {
			throw new errorCode('hytale.non_json', {
				contentType: contentType ?? null,
			});
		}

		let body = null;
		try {
			body = JSON.parse(parsed.bodyData);
		} catch (parseErr) {
			console.error('[Hytale] Failed to parse TCP response JSON:', parseErr);
			throw new errorCode('hytale.api_failure', { message: 'Invalid JSON in API response' });
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
 * Check if a string is a UUID format
 */
function isUuid(query: string): boolean {
	const uuidRegex = /^[\da-f]{8}(?:-?[\da-f]{4}){3}-?[\da-f]{12}$/i;
	return uuidRegex.test(query);
}

/**
 * Check if error should be rethrown without fallback
 */
function shouldSkipHttpFallback(err: any): boolean {
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
 * Tries TCP first for better rate limit avoidance, falls back to regular HTTP
 */
async function fetchProfileFromApi(
	query: string,
	sessionToken: string,
	tokenManager: DurableObjectStub<HytaleTokenManager>,
	ctx: ExecutionContext,
): Promise<{ data: Record<string, any>; request_type: string; }> {
	const path = isUuid(query)
		? `/profile/uuid/${encodeURIComponent(query)}`
		: `/profile/username/${encodeURIComponent(query)}`;

	let apiResponse;
	let usedTcp = false;

	try {
		console.log('[Hytale] Trying TCP request');
		apiResponse = await helpers.tcpRequest(path, sessionToken);
		usedTcp = true;
	} catch (tcpErr: any) {
		if (shouldSkipHttpFallback(tcpErr)) {
			maybeReportRateLimit(tcpErr, sessionToken, tokenManager, ctx);
			throw tcpErr;
		}

		console.log('[Hytale] TCP failed, falling back to HTTP:', tcpErr?.message || tcpErr);

		try {
			apiResponse = await helpers.request({
				url: `${ACCOUNT_DATA_URL}${path}`,
				headers: {
					Authorization: `Bearer ${sessionToken}`,
				},
			});
		} catch (httpErr: any) {
			maybeReportRateLimit(httpErr, sessionToken, tokenManager, ctx);
			throw httpErr;
		}
	}

	console.log('[Hytale] Raw API response (%s):', usedTcp ? 'TCP' : 'HTTP', JSON.stringify(apiResponse, null, 2));

	const data = helpers.parse(apiResponse);
	data.meta ??= {};
	data.meta.cached_at = Math.round(Date.now() / 1000);

	return { data, request_type: usedTcp ? 'tcp' : 'http' };
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
		const result = await fetchProfileFromApi(query, sessionToken, tokenManager, ctx);
		returnData = result.data;
		request_type = result.request_type;
	} catch (err: any) {
		// If auth error, invalidate tokens and retry with fresh ones
		if (err?.isAuthError) {
			console.log('[Hytale] Auth error, invalidating tokens and retrying');
			await tokenManager.invalidateTokens();
			const freshToken = await tokenManager.getSessionToken(true);
			const result = await fetchProfileFromApi(query, freshToken, tokenManager, ctx);
			returnData = result.data;
			request_type = result.request_type;
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
