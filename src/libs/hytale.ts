import { writeDataPoint } from './analytics';
import * as helperCodes from './helpers';
import { errorCode, failCode } from './helpers';

import type { Environment, HonoEnv } from '../types';
import type { Context } from 'hono';

// TODO: Update this URL when Hytale API is available
const apiUrl = 'https://api.hytale.com/';
const oneDay = 60 * 60 * 24;
const kvCacheTtl = oneDay * 7; // 7 days for KV
const cacheTtl = oneDay * 5; // 5 days for edge/response

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
		const url = new URL(apiUrl);
		data.qs = data.qs || {};

		url.search = new URLSearchParams(data.qs).toString();
		url.pathname += data.path;

		let response;
		try {
			response = await fetch(url.href, {
				method: 'GET',
				headers: data.headers,
				cf: {
					cacheEverything: true,
					cacheTtl,
				},
				signal: AbortSignal.timeout(5000),
			});
		} catch (err) {
			console.error('Hytale API request failed:', err);
			throw new errorCode('hytale.api_failure');
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
				url.href,
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
	 * TODO: Update this when the actual API response format is known
	 */
	parse(data: any): Record<string, any> {
		return {
			// TODO: Map actual Hytale API fields
			id: data.id || data.uuid || data.player_id,
			username: data.username || data.name || data.display_name,
			avatar: data.avatar || data.avatar_url || null,
			meta: {
				// TODO: Add Hytale-specific metadata fields
				// Examples might include:
				// - account_created: data.created_at,
				// - server_count: data.servers_played,
				// - achievements: data.achievements,
				...data,
			},
		};
	},
};

/**
 * Validate a Hytale player identifier
 * TODO: Update validation when ID format is known
 */
function isValidIdentifier(query: string): boolean {
	// TODO: Update these validation rules based on actual Hytale ID formats
	// For now, accept:
	// - Usernames: 3-16 alphanumeric characters with underscores
	// - UUIDs: standard UUID format
	const usernameRegex = /^\w{3,16}$/;
	const uuidRegex = /^[\da-f]{8}(?:-?[\da-f]{4}){3}-?[\da-f]{12}$/i;

	return usernameRegex.test(query) || uuidRegex.test(query);
}

async function getProfile(
	query: string,
	env: Environment,
	ctx: ExecutionContext,
): Promise<{ data: Record<string, any>; request_type: string; }> {
	const kvKey = 'hytale-profile-' + query.toLowerCase();

	try {
		if (env.BYPASS_CACHE !== 'true') {
			const cached = await env.PLAYERDB_CACHE.get(kvKey, {
				type: 'json',
				cacheTtl: oneDay,
			});
			if (cached) {
				return { data: cached as Record<string, any>, request_type: 'kv_cache' };
			}
		}
	} catch {
		// KV lookup failed, continue with API
	}

	// Validate the identifier format
	if (!isValidIdentifier(query)) {
		throw new failCode('hytale.invalid_identifier');
	}

	// TODO: Implement actual API call when Hytale API is available
	// For now, throw an error indicating the API is not yet available
	throw new errorCode('hytale.api_unavailable');

	// TODO: Uncomment and update when API is available:
	// const apiResponse = await helpers.request({
	// 	path: 'players/' + encodeURIComponent(query),
	// 	// qs: { key: env.HYTALE_APIKEY },
	// }, env);
	//
	// const returnData = helpers.parse(apiResponse);
	// returnData.cached_at = Date.now();
	//
	// // Cache the result by original query
	// ctx.waitUntil(
	// 	env.PLAYERDB_CACHE.put(kvKey, JSON.stringify(returnData), {
	// 		expirationTtl: kvCacheTtl,
	// 	}),
	// );
	//
	// // Also cache by player ID if different from query
	// const idKey = 'hytale-profile-' + returnData.id.toLowerCase();
	// if (idKey !== kvKey) {
	// 	ctx.waitUntil(
	// 		env.PLAYERDB_CACHE.put(idKey, JSON.stringify(returnData), {
	// 			expirationTtl: kvCacheTtl,
	// 		}),
	// 	);
	// }
	//
	// return { data: returnData, request_type: apiResponse.request_type };
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
