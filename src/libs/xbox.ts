import { writeDataPoint } from './analytics';
import * as helperCodes from './helpers';
import {
	camelCase,
	camelCaseCache,
	errorCode,
	failCode,
} from './helpers';

import type { Environment, HonoEnv } from '../types';
import type { Context } from 'hono';

const apiUrl = 'https://xbl.io/';
const apiVersion = '/api/v2/';
const oneDay = 60 * 60 * 24;
const kvCacheTtl = oneDay * 30; // keep profiles past freshness so they can be served stale while quota is spent
const freshTtl = oneDay * 7; // profiles younger than this are served without touching upstream
const cacheTtl = oneDay * 5; // 5 days for edge/response
const staleTtl = 60; // short edge TTL on stale hits so clients recheck once quota recovers
const notFoundTtl = oneDay; // most misses are permanent, and scrapers re-query them relentlessly
const notFoundSentinel = { __not_found: true };

// xbl.io reports quota on every response via x-ratelimit-*. Once it is spent every
// further call is burned for nothing, so the exhaustion is shared globally via KV.
const quotaKey = 'xbox-quota-exhausted';
const quotaReserve = 2; // stop short of the hard 429 so concurrent requests don't trip it
const quotaBlockTtl = 900; // quota resets hourly; re-probe well inside that window
const quotaProbeRate = 0.01; // share of blocked requests allowed upstream to detect recovery

const responseHeaders = {
	'content-type': 'application/json; charset=utf-8',
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, OPTIONS',
	'Cache-Control': `public, max-age=${cacheTtl}`,
} as const;

// stale hits are deliberately short-lived at the edge so a recovered quota is picked up quickly
const staleResponseHeaders = {
	...responseHeaders,
	'Cache-Control': `public, max-age=${staleTtl}`,
	'X-Playerdb-Stale': 'true',
} as const;

type RequestData = {
	path: string;
	headers?: Record<string, string>;
	qs?: Record<string, string>;
};
// Surfaces upstream throttling as a 429 the caller can back off on, while keeping
// the specific cause distinguishable in analytics.
function throttled(analyticsCode: string) {
	const err = new errorCode('xbox.rate_limited', { statusCode: 429 });
	err.analyticsCode = analyticsCode;
	return err;
}

function readQuota(headers: Headers) {
	const limit = headers.get('x-ratelimit-limit');
	const remaining = headers.get('x-ratelimit-remaining');
	if (limit === null || remaining === null) {
		return null;
	}
	const parsed = { limit: Number(limit), remaining: Number(remaining) };
	if (!Number.isFinite(parsed.limit) || !Number.isFinite(parsed.remaining)) {
		return null;
	}
	return parsed;
}

function blockUpstream(honoCtx: Context<HonoEnv>) {
	honoCtx.executionCtx.waitUntil(
		honoCtx.env.PLAYERDB_CACHE.put(quotaKey, String(Date.now()), {
			expirationTtl: quotaBlockTtl,
		}).catch(() => {
			// best effort; upstream still enforces its own limit
		}),
	);
}

async function checkQuota(honoCtx: Context<HonoEnv>): Promise<{ blocked: boolean; probe: boolean; }> {
	if (honoCtx.env.BYPASS_CACHE === 'true') {
		return { blocked: false, probe: false };
	}
	let blockedAt = null;
	try {
		blockedAt = await honoCtx.env.PLAYERDB_CACHE.get(quotaKey, { cacheTtl: 60 });
	} catch {
		// an unreadable gate is treated as open
	}
	if (blockedAt === null) {
		return { blocked: false, probe: false };
	}
	// let a trickle through so recovery is detected without a thundering herd
	if (Math.random() < quotaProbeRate) {
		return { blocked: false, probe: true };
	}
	return { blocked: true, probe: false };
}

const helpers = {
	async request(data: RequestData, honoCtx: Context<HonoEnv>) {
		// defaults, with `data` merged in
		const payload = {
			method: 'GET',
			cf: {
				cacheEverything: true,
				cacheTtl,
			},
			...data,
			signal: AbortSignal.timeout(5000),
		};
		const url = new URL(apiUrl);
		url.pathname = apiVersion;
		url.pathname += payload.path;

		if (data.qs) {
			url.search = new URLSearchParams(data.qs).toString();
		}

		let response;
		try {
			response = await fetch(url.href, payload);
		} catch (err) {
			// Handle timeout and network errors
			console.error('Xbox API request failed:', err);
			throw new errorCode('xbox.api_failure');
		}

		// Failures burn quota too, so record it before any error path returns.
		const quota = readQuota(response.headers);
		if (quota) {
			honoCtx.set('xboxQuotaRemaining', quota.remaining);
			if (quota.remaining <= quotaReserve) {
				blockUpstream(honoCtx);
			}
		}

		if (response.status === 429) {
			blockUpstream(honoCtx);
			throw throttled('xbox.rate_limited');
		}

		const contentType = response.headers.get('content-type');
		if (!contentType || !contentType.includes('json')) {
			// xbl.io serves an HTML page when it throttles us, so back off instead of
			// reporting a 500 the caller has no way to act on.
			blockUpstream(honoCtx);
			throw throttled('xbox.non_json');
		}
		let text = '';
		let body = null;
		try {
			text = await response.text();
			body = text ? JSON.parse(text) : null;
		} catch (err) {
			console.error('Failed to parse Xbox API response as JSON:', err);
			console.error(text);
		}

		if (response.status !== 200) {
			// other API failure
			console.log('Xbox API returned error status:', response.status, body);
			throw new errorCode('xbox.bad_response_code', {
				status: response.status,
			});
		}

		if (!body || !body.content) {
			throw new errorCode('xbox.bad_response');
		}

		if (body.code === 429) {
			// upstream api is rate limited contacting the xbox live services
			blockUpstream(honoCtx);
			throw throttled('xbox.rate_limited');
		}

		if (body.code !== 200) {
			if (body.code === 404 || body.content.code === 59 || body.content.code === 28) {
				// catch no user found. id uses code 59, username search uses 28
				throw new failCode('xbox.not_found');
			}

			throw new errorCode('xbox.bad_response', {
				message: body.content.description || null,
				error_code: body.content.code || body.code,
			});
		}

		body.request_type = 'http';
		return body;
	},
	parse(data: Record<string, any>) {
		const raw: Record<string, any> | undefined = data?.content?.profileUsers?.[0];
		if (!raw) {
			// a 200 carrying no profile is an upstream glitch, not a confirmed miss, so
			// don't let it poison the negative cache
			throw new errorCode('xbox.bad_response');
		}
		const player: Record<string, any> = { id: raw.id, meta: {} };

		// Process settings efficiently
		for (const setting of raw.settings || []) {
			// Check if it's a mapped field
			if (helpers.map[setting.id as keyof typeof helpers.map]) {
				player[helpers.map[setting.id as keyof typeof helpers.map]] = setting.value;
			} else if (!helpers.skipFields.has(setting.id)) {
				// Skip known unnecessary fields, cache camelCase conversion
				const camelKey = camelCaseCache[setting.id] || (camelCaseCache[setting.id] = camelCase(setting.id));
				player.meta[camelKey] = setting.value;
			}
		}

		// ensure a username is defined: Gamertag → UniqueModernGamertag → ModernGamertag → RealName
		if (!player.username) {
			player.username = player.uniqueModernGamertag || player.modernGamertag || player.meta.realName;
		}

		// fix GameDisplayPicRaw: remove mode=Padding which causes 400 errors, and request a larger size
		if (player.avatar && player.avatar.includes('images-eds-ssl.xboxlive.com')) {
			const avatarUrl = new URL(player.avatar);
			avatarUrl.searchParams.delete('mode');
			avatarUrl.searchParams.set('h', '180');
			avatarUrl.searchParams.set('w', '180');
			player.avatar = avatarUrl.toString();
		}

		// fallback if GameDisplayPicRaw was not present
		if (!player.avatar) {
			player.avatar = `https://avatar-ssl.xboxlive.com/avatar/${player.username}/avatarpic-l.png`;
		}

		return player;
	},
	map: {
		Gamertag: 'username',
		GameDisplayPicRaw: 'avatar',
		UniqueModernGamertag: 'uniqueModernGamertag',
		ModernGamertag: 'modernGamertag',
		ModernGamertagSuffix: 'modernGamertagSuffix',
	},
	// Skip fields we don't need to process
	skipFields: new Set<string>(),
};

type CacheHit = { data: Record<string, unknown>; stale: boolean; };

async function readProfileCache(kvKey: string, env: Environment): Promise<CacheHit | null> {
	if (env.BYPASS_CACHE === 'true') {
		return null;
	}
	const cached = await env.PLAYERDB_CACHE.get<Record<string, unknown>>(kvKey, {
		type: 'json',
		cacheTtl: oneDay,
	});
	if (!cached) {
		return null;
	}
	if (cached.__not_found) {
		const err = new failCode('xbox.not_found');
		err.cached = true;
		throw err;
	}
	const cachedAt = typeof cached.cached_at === 'number' ? cached.cached_at : 0;
	return { data: cached, stale: Date.now() - cachedAt > freshTtl * 1000 };
}

async function searchGamertag(query: string, honoCtx: Context<HonoEnv>) {
	const headers = { 'X-Authorization': honoCtx.env.XBOX_APIKEY };

	try {
		return await helpers.request({ path: 'friends/search', qs: { gt: query }, headers }, honoCtx);
	} catch (err) {
		// Floodgate substitutes underscores for spaces in Bedrock gamertags, so a miss
		// on an underscored name is worth one retry with the spaces restored.
		if (err instanceof failCode && err.code === 'xbox.not_found' && query.includes('_')) {
			const gt = query.replaceAll('_', ' ');
			return await helpers.request({ path: 'friends/search', qs: { gt }, headers }, honoCtx);
		}
		throw err;
	}
}

async function getProfile(
	query: string,
	honoCtx: Context<HonoEnv>,
): Promise<{ data: Record<string, unknown>; request_type: string; }> {
	const env = honoCtx.env;
	const ctx = honoCtx.executionCtx;
	// Normalize query for cache key
	const kvKey = 'xbox-profile-' + query.toLowerCase();

	let cached: CacheHit | null = null;
	try {
		cached = await readProfileCache(kvKey, env);
	} catch (err) {
		if (err instanceof failCode) {
			throw err;
		}
		// KV lookup failed, continue with API
	}

	if (cached && !cached.stale) {
		return { data: cached.data, request_type: 'kv_cache' };
	}

	// Don't spend a call we already know will fail; stale data beats a 429.
	const gate = await checkQuota(honoCtx);
	if (gate.blocked) {
		if (cached) {
			return { data: cached.data, request_type: 'kv_stale' };
		}
		throw throttled('xbox.quota_exhausted');
	}

	const isXuid = /^\d{1,16}$/.test(query);
	let data;

	try {
		if (isXuid) {
			// lookup by ID
			data = await helpers.request({
				path: `account/${query}`,
				headers: {
					'X-Authorization': env.XBOX_APIKEY,
				},
			}, honoCtx);
		} else {
			data = await searchGamertag(query, honoCtx);
		}
	} catch (err) {
		if (err instanceof failCode && err.code === 'xbox.not_found') {
			// negative cache not-found results to avoid burning rate limit
			ctx.waitUntil(
				env.PLAYERDB_CACHE.put(kvKey, JSON.stringify(notFoundSentinel), {
					expirationTtl: notFoundTtl,
				}),
			);
		} else if (cached) {
			// upstream is throttled or broken, so a stale profile beats an error
			return { data: cached.data, request_type: 'kv_stale' };
		}
		throw err;
	}

	if (gate.probe) {
		// recovery confirmed, reopen the gate for everyone
		ctx.waitUntil(env.PLAYERDB_CACHE.delete(quotaKey).catch(() => {}));
	}

	// Parse the response data
	const returnData: Record<string, unknown> = helpers.parse(data);
	if (isXuid) {
		returnData.id = query;
	}
	returnData.cached_at = Date.now();

	// Cache the result by original query
	ctx.waitUntil(
		env.PLAYERDB_CACHE.put(kvKey, JSON.stringify(returnData), {
			expirationTtl: kvCacheTtl,
		}),
	);

	// Also cache by XUID if different from query
	if (returnData.id && String(returnData.id).toLowerCase() !== query.toLowerCase()) {
		const xuidKey = 'xbox-profile-' + String(returnData.id).toLowerCase();
		ctx.waitUntil(
			env.PLAYERDB_CACHE.put(xuidKey, JSON.stringify(returnData), {
				expirationTtl: kvCacheTtl,
			}),
		);
	}

	return { data: returnData, request_type: data.request_type };
}

const lookup = async function lookup(honoCtx: Context<HonoEnv>) {
	const query = honoCtx.get('lookupQuery');

	if (!query) {
		throw new failCode('api.404');
	}

	const { data: returnData, request_type } = await getProfile(query, honoCtx);

	writeDataPoint(honoCtx, {
		type: 'xbox',
		request_type,
		status: 200,
	});

	// Construct response with success wrapper
	const responseFull = helperCodes.code('player.found', { player: returnData }) as Record<
		string,
		unknown
	>;
	responseFull.success = true;

	const headers = request_type === 'kv_stale' ? staleResponseHeaders : responseHeaders;
	return honoCtx.json(responseFull, 200, headers);
};

export default lookup;
