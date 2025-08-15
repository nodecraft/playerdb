// eslint-disable-next-line n/no-missing-import
import { connect } from 'cloudflare:sockets';

import { writeDataPoint } from './analytics';
import { errorCode, failCode } from './helpers';
import { parseResponse } from './http';

import type { Environment } from '../types';

const avatarURL = 'https://crafthead.net/avatar/';
const apiPrimary = 'https://api.mojang.com/';
const apiSessions = 'https://sessionserver.mojang.com/';
const apiServices = 'https://api.minecraftservices.com/';

const flyProxy = 'https://playerdb.fly.dev/';
const oneDay = 60 * 60 * 24;
const cacheTtl = oneDay * 7; // 7 days

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

		try {
			const socket = await connect(
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
			const encoded = encoder.encode(`${joined}\r\n\r\n\r\n`);
			await writer.write(encoded);

			const reader = socket.readable.getReader();
			const decoder = new TextDecoder();

			// loop and append data to buffer
			let result = '';
			// eslint-disable-next-line no-constant-condition
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				result += decoder.decode(value);
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
		} catch (err) {
			// pass through mojang errors
			// @ts-expect-error error not properly typed
			if (err?.code?.startsWith?.('minecraft.')) {
				throw err;
			}
			// catch socket errors generically
			console.error(err);
			throw new errorCode('minecraft.api_failure');
		}
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
			url.searchParams.set('api_key', (env as Environment).NODECRAFT_API_KEY || '');
		}
		const response = await fetch(url.href, {
			method: 'GET',
			cf: {
				cacheEverything: true,
				cacheTtl,
			},
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
		return [
			id.slice(0, 8),
			'-',
			id.slice(8, 12),
			'-',
			id.slice(12, 16),
			'-',
			id.slice(16, 20),
			'-',
			id.slice(20),
		].join('');
	},
};

const mojangLib = {
	async username(
		username: string,
		date: number | null,
		env: Environment,
		ctx: ExecutionContext,
	) {
		const kvKey = 'minecraft-username-' + username;
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
		results = await mojangLib.profile(results.id, env, ctx);
		results.formatted_id = helpers.formatId(results.id);
		results.cached_at = Date.now();
		ctx.waitUntil(
			env.PLAYERDB_CACHE.put(kvKey, JSON.stringify(results), {
				expirationTtl: cacheTtl,
			}),
		);
		return results;
	},
	async profile(uuid: string, env: Environment, ctx: ExecutionContext) {
		const kvKey = 'minecraft-profile-' + uuid;
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
	request: Request,
	env: Environment,
	ctx: ExecutionContext,
) {
	const url = new URL(request.url);
	const username = url.pathname.split('/').pop() || ''; // get last segment of URL pathname

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

	writeDataPoint(env, request, {
		type: 'minecraft',
		request_type: profile.request_type,
		status: 200,
	});
	return { player: returnData };
};

export default lookup;
