// eslint-disable-next-line n/no-missing-import
import { connect } from 'cloudflare:sockets';

import { writeDataPoint } from './analytics';
import * as helperCodes from './helpers';
import { errorCode, failCode } from './helpers';
import { parseResponse } from './http';

import type { Environment, HonoEnv } from '../types';
import type { Context } from 'hono';

const avatarURL = 'https://crafthead.net/avatar/';
const apiPrimary = 'https://api.mojang.com/';
const apiSessions = 'https://sessionserver.mojang.com/';
const apiServices = 'https://api.minecraftservices.com/';

const flyProxy = 'https://playerdb.fly.dev/';
const oneDay = 60 * 60 * 24;
const cacheTtl = oneDay * 7; // 7 days
const responseCacheTtl = oneDay * 5; // 5 days

const responseHeaders = {
	'content-type': 'application/json; charset=utf-8',
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, OPTIONS',
	'Cache-Control': `public, max-age=${responseCacheTtl}`,
} as const;

type Payload = {
	username?: string;
	id?: string;
	date?: number;
};

type RequestData = {
	host?: string;
	path: string;
	qs?: Record<string, string>;
};

const helpers = {
	async nodecraftAPIRequest(payload: Payload, env: Environment) {
		const url = new URL('/v2/playerdb', 'https://api.nodecraft.com');
		url.searchParams.set('type', 'minecraft');
		url.searchParams.set('api_key', env.NODECRAFT_API_KEY ?? '');
		if (payload.username) {
			url.searchParams.set('username', payload.username);
		}
		if (payload.id) {
			url.searchParams.set('id', payload.id);
		}

		const response = await fetch(url.href, {
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
		if (response.status === 429) {
			// rate limited, we're done
			throw new errorCode('minecraft.rate_limited', { statusCode: 429 });
		}
		let body = null;
		try {
			body = await response.json<any>();
		} catch {
			// we tried
		}
		if (response.status === 404 && body?.errorMessage?.includes?.('Couldn\'t find any profile with name')) {
			throw new failCode('minecraft.invalid_username', { statusCode: 400 });
		}

		if (response.status === 204 && !body) {
			// bad username
			throw new failCode('minecraft.invalid_username', { statusCode: 400 });
		}

		if (response.status !== 200) {
			// other API failure
			console.log('got non-200 response from nodecraft api', response.status, body);
			throw new errorCode('minecraft.api_failure');
		}

		const contentType = response.headers.get('content-type');
		if (!contentType || !contentType.includes('json')) {
			throw new errorCode('minecraft.non_json', { contentType: contentType || null });
		}

		body.request_type = 'nodecraft_api';
		return body;
	},
	async tcpRequest(data: RequestData) {
		const url = new URL((data.host ?? apiPrimary) + data.path);
		if (data.qs) {
			url.search = new URLSearchParams(data.qs).toString();
		}

		const timeoutMs = 5000;
		let socket: Awaited<ReturnType<typeof connect>> | null = null;
		let timeoutId: ReturnType<typeof setTimeout> | null = null;

		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutId = setTimeout(() => {
				// Close socket on timeout to free resources
				if (socket) {
					try {
						socket.close();
					} catch {
						// Ignore close errors
					}
				}
				reject(new errorCode('minecraft.api_failure', { message: 'TCP request timed out' }));
			}, timeoutMs);
		});

		const requestPromise = (async () => {
			socket = await connect(
				{
					hostname: url.hostname,
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
				`GET ${url.pathname}${url.search} HTTP/1.1`,
				`Host: ${url.hostname}`,
				'Accept: application/json',
				'Connection: close',
			];
			const joined = rawHTTPReq.join('\r\n');
			const encoded = encoder.encode(`${joined}\r\n\r\n`);
			await writer.write(encoded);

			const reader = socket.readable.getReader();

			// Collect all chunks as Uint8Arrays first, then decode at the end.
			// This avoids issues with multi-byte UTF-8 characters being split across TCP chunks.
			const chunks: Uint8Array[] = [];
			let totalLength = 0;
			// eslint-disable-next-line no-constant-condition
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				chunks.push(value);
				totalLength += value.length;
			}
			socket.close();

			// Concatenate all chunks and decode once
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
			// pass through minecraft errors (including timeout)
			// @ts-expect-error error not properly typed
			if (err?.code?.startsWith?.('minecraft.')) {
				throw err;
			}
			// catch socket errors generically
			console.error(err);
			throw new errorCode('minecraft.api_failure');
		} finally {
			// Clear timeout if request completed successfully
			if (timeoutId) {
				clearTimeout(timeoutId);
			}
		}

		const parsed = parseResponse(result);

		if (parsed.statusCode === 429) {
			// rate limited, we're done
			throw new errorCode('minecraft.rate_limited', { statusCode: 429 });
		}
		let body = null;
		try {
			body = JSON.parse(parsed.bodyData);
		} catch {
			// we tried
		}
		if (
			parsed.statusCode === 404 &&
			body?.errorMessage?.includes?.('Couldn\'t find any profile with name')
		) {
			throw new failCode('minecraft.invalid_username', { statusCode: 400 });
		}

		if (parsed.statusCode === 204 && !body) {
			// bad username
			throw new failCode('minecraft.invalid_username', { statusCode: 400 });
		}

		if (parsed.statusCode !== 200) {
			// other API failure
			console.log(
				'got non-200 response from TCP mojang',
				parsed.statusCode,
				body,
			);
			throw new errorCode('minecraft.api_failure');
		}

		const contentType = parsed.headers['content-type'];
		if (!contentType || !contentType.includes('json')) {
			throw new errorCode('minecraft.non_json', {
				contentType: contentType || null,
			});
		}
		body.request_type = 'tcp';
		return body;
	},
	// hit mojang api
	async request(
		data: RequestData,
		payload: Payload = {},
		env: Environment,
	): Promise<Record<string, unknown>> {
		const url = new URL((data.host ?? apiPrimary) + data.path);
		if (data.qs) {
			url.search = new URLSearchParams(data.qs).toString();
		}
		if (data.host?.includes(flyProxy)) {
			url.searchParams.set('api_key', env.NODECRAFT_API_KEY || '');
		}
		const response = await fetch(url.href, {
			method: 'GET',
			cf: {
				cacheEverything: true,
				cacheTtl,
			},
			signal: AbortSignal.timeout(5000),
		});

		if (response.status === 429 || response.status === 403) {
			if (data.host && data.host.includes(flyProxy)) {
				// rate limited, one final try on nodecraft api
				return helpers.nodecraftAPIRequest(payload, env);
			}

			// rate-limited, try fly proxy
			return helpers.request({
				...data,
				host: flyProxy,
			}, payload, env);
		}

		let body = null;
		try {
			body = await response.json<any>();
		} catch {
			// we tried
		}

		if (
			response.status === 404 &&
			body?.errorMessage?.includes?.('Couldn\'t find any profile with name')
		) {
			throw new failCode('minecraft.invalid_username', { statusCode: 400 });
		}

		if (response.status === 204 && !body) {
			// bad username
			throw new failCode('minecraft.invalid_username', { statusCode: 400 });
		}

		if (response.status !== 200) {
			// other API failure
			console.warn('got non-200 response', response.status, body);
			throw new errorCode('minecraft.api_failure');
		}

		const contentType = response.headers.get('content-type');
		if (!contentType || !contentType.includes('json')) {
			throw new errorCode('minecraft.non_json', {
				contentType: contentType || null,
			});
		}

		body.request_type = 'http';
		return body;
	},
	formatId(id: string) {
		// take a mojang UUID in format `ef6134805b6244e4a4467fbe85d65513` and return `ef613480-5b62-44e4-a446-7fbe85d65513`
		return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
	},
};

const mojangLib = {
	async username(
		username: string,
		date: number | null,
		env: Environment,
		ctx: ExecutionContext,
	) {
		const kvKey = 'minecraft-username-' + username.toLowerCase();
		let results = null;
		try {
			if (env.BYPASS_CACHE !== 'true') {
				results = await env.PLAYERDB_CACHE.get(kvKey, {
					type: 'json',
					cacheTtl: oneDay,
				});
			}
		} catch {
			// nothing in KV
		}
		if (results) {
			// Add cache hit metadata for monitoring
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(results as any).cached_at = (results as any).cached_at || Date.now();
			return results;
		}
		// no cache, do full lookup
		if (!date) {
			date = Date.now();
		}
		try {
			// try over TCP first
			results = await helpers.tcpRequest({
				host: apiServices,
				path: 'minecraft/profile/lookup/name/' + username,
				qs: {
					date: String(date),
				},
			});
		} catch (err) {
			// @ts-expect-error error not properly typed
			if (err?.code === 'minecraft.invalid_username') {
				throw err;
			}
			console.warn('TCP failed, falling back to HTTP', err);
			results = await helpers.request(
				{
					host: apiServices,
					path: 'minecraft/profile/lookup/name/' + username,
					qs: {
						date: String(date),
					},
				},
				{
					username: username,
					date: date,
				},
				env,
			);
		}

		// now we have their ID we can do a UUID lookup
		// Note: profile() will cache the UUID→profile mapping in KV
		results = await mojangLib.profile(results.id, env, ctx);
		results.formatted_id = helpers.formatId(results.id);
		results.cached_at = Date.now();
		// Cache the username→profile mapping (profile cache is already handled in profile())
		ctx.waitUntil(
			env.PLAYERDB_CACHE.put(kvKey, JSON.stringify(results), {
				expirationTtl: cacheTtl,
			}),
		);
		return results;
	},
	async profile(uuid: string, env: Environment, ctx: ExecutionContext) {
		const kvKey = 'minecraft-profile-' + uuid.toLowerCase().replaceAll('-', '');
		let results = null;
		try {
			if (env.BYPASS_CACHE !== 'true') {
				results = await env.PLAYERDB_CACHE.get(kvKey, {
					type: 'json',
					cacheTtl: oneDay,
				});
			}
		} catch {
			// nothing in KV
		}
		if (results) {
			return results;
		}
		const lookup = String(uuid).replaceAll('-', '');
		try {
			// try over TCP first
			results = await helpers.tcpRequest({
				host: apiSessions,
				path: `session/minecraft/profile/${lookup}?unsigned=false`,
			});
		} catch (err) {
			// no need to try and fallback to HTTP if we got this error
			// @ts-expect-error error not properly typed
			if (err?.code === 'minecraft.invalid_username') {
				throw err;
			}
			console.warn('TCP failed, falling back to HTTP', err);
			results = await helpers.request(
				{
					host: apiSessions,
					path: `session/minecraft/profile/${lookup}?unsigned=false`,
				},
				{
					id: lookup,
				},
				env,
			);
		}
		results.formatted_id = helpers.formatId(results.id);
		results.cached_at = Date.now();
		ctx.waitUntil(
			env.PLAYERDB_CACHE.put(kvKey, JSON.stringify(results), {
				expirationTtl: cacheTtl,
			}),
		);
		return results;
	},
};

const lookup = async function lookup(
	honoCtx: Context<HonoEnv>,
) {
	const env = honoCtx.env;
	const ctx = honoCtx.executionCtx as ExecutionContext;

	const username = honoCtx.get('lookupQuery') || '';

	// no username, return 404
	if (username === '') {
		throw new failCode('api.404');
	}

	// if username contains any non-alphanumeric characters plus - and _, return 400
	if (!/^[\w-]+$/.test(username)) {
		throw new failCode('minecraft.invalid_username', { statusCode: 400 });
	}

	const returnData: Record<string, any> = { meta: {} };
	let profile = null;
	if (username.length === 32 || username.length === 36) {
		profile = await mojangLib.profile(username, env, ctx);
	} else {
		profile = await mojangLib.username(username, null, env, ctx);
	}
	returnData.username = profile.name;
	returnData.id = profile.formatted_id;
	returnData.raw_id = profile.id;
	returnData.avatar = avatarURL + profile.id;
	// getting the avatar URL is a bit fun. It's store in properties in the profile, but we need to find the one named 'textures'
	// and then get the URL from there. If it's not there, we can't get the avatar.
	if (profile.properties) {
		for (const prop of profile.properties) {
			if (prop.name === 'textures') {
				const textures = JSON.parse(atob(prop.value));
				if (textures.textures && textures.textures.SKIN) {
					returnData.skin_texture = textures.textures.SKIN.url;
				}
				break; // Found textures property, no need to continue
			}
		}
		// Also push properties into the return data
		returnData.properties = profile.properties;
	}
	if (profile.cached_at) {
		returnData.meta.cached_at = Math.round(profile.cached_at / 1000);
	}

	// mojang disabled this API: https://help.minecraft.net/hc/en-us/articles/8969841895693
	// but for backwards compatibility, still return this property, just empty
	returnData.name_history = [];

	writeDataPoint(honoCtx, {
		type: 'minecraft',
		request_type: profile.request_type,
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
