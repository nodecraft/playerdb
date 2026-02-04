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
const kvCacheTtl = oneDay * 7; // 7 days for KV
const cacheTtl = oneDay * 5; // 5 days for edge/response
const notFoundTtl = 60 * 60; // 1 hour for negative cache
const notFoundSentinel = { __not_found: true };

const responseHeaders = {
	'content-type': 'application/json; charset=utf-8',
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, OPTIONS',
	'Cache-Control': `public, max-age=${cacheTtl}`,
} as const;

type RequestData = {
	path: string;
	headers?: Record<string, string>;
	qs?: Record<string, string>;
};
const helpers = {
	async request(data: RequestData) {
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

		if (response.status === 429) {
			throw new errorCode('xbox.rate_limited', { statusCode: 429 });
		}

		if (response.status !== 200) {
			// other API failure
			throw new errorCode('xbox.bad_response_code', {
				status: response.status,
			});
		}

		const contentType = response.headers.get('content-type');
		if (!contentType || !contentType.includes('json')) {
			throw new errorCode('xbox.non_json', {
				contentType: contentType || null,
			});
		}

		let body = null;
		try {
			body = await response.json<any>();
		} catch {
			// we tried
		}

		if (!body || body.status === false) {
			throw new errorCode('xbox.bad_response', { message: body?.message });
		}

		if (body.code && body.description) {
			// API responds with a 200 code, and a `code` and `description` on many errors
			if (body.code === 2 || body.code === 28) {
				// catch no user found. id uses code 2, username search uses 28
				throw new failCode('xbox.not_found');
			}
			throw new errorCode('xbox.bad_response', {
				message: body.description,
				error_code: body.code,
			});
		}

		body.request_type = 'http';
		return body;
	},
	parse(data: Record<string, any>) {
		let raw: Record<string, any> = {};
		let player: Record<string, any> = {};
		if (data?.profileUsers?.[0]) {
			raw = data.profileUsers[0];
			player = { id: raw.id, meta: {} };
		}

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

async function getProfile(
	query: string,
	env: Environment,
	ctx: ExecutionContext,
): Promise<{ data: Record<string, unknown>; request_type: string; }> {
	// Normalize query for cache key
	const kvKey = 'xbox-profile-' + query.toLowerCase();

	// Check KV cache first
	try {
		if (env.BYPASS_CACHE !== 'true') {
			const cached = await env.PLAYERDB_CACHE.get(kvKey, {
				type: 'json',
				cacheTtl: oneDay,
			});
			if (cached) {
				if ((cached as Record<string, unknown>).__not_found) {
					throw new failCode('xbox.not_found');
				}
				return { data: cached as Record<string, unknown>, request_type: 'kv_cache' };
			}
		}
	} catch (err) {
		if (err instanceof failCode) {
			throw err;
		}
		// KV lookup failed, continue with API
	}

	const isXuid = /^\d{1,16}$/.test(query);
	let returnData: Record<string, unknown> = {};
	let data;

	try {
		if (isXuid) {
			// lookup by ID
			returnData.id = query;
			data = await helpers.request({
				path: `account/${query}`,
				headers: {
					'X-Authorization': env.XBOX_APIKEY,
				},
			});
		} else {
			// lookup by username
			data = await helpers.request({
				path: 'friends/search',
				qs: {
					gt: query,
				},
				headers: {
					'X-Authorization': env.XBOX_APIKEY,
				},
			});
		}
	} catch (err) {
		if (err instanceof failCode && err.code === 'xbox.not_found') {
			// negative cache not-found results to avoid burning rate limit
			ctx.waitUntil(
				env.PLAYERDB_CACHE.put(kvKey, JSON.stringify(notFoundSentinel), {
					expirationTtl: notFoundTtl,
				}),
			);
		}
		throw err;
	}

	// Parse the response data
	returnData = { ...helpers.parse(data), ...returnData };
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
	const env = honoCtx.env;
	const ctx = honoCtx.executionCtx as ExecutionContext;

	const query = honoCtx.get('lookupQuery');

	if (!query) {
		throw new failCode('api.404');
	}

	const { data: returnData, request_type } = await getProfile(query, env, ctx);

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

	return honoCtx.json(responseFull, 200, responseHeaders);
};

export default lookup;
