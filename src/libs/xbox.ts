import camelCase from 'lodash/camelCase';

import { writeDataPoint } from './analytics';
import { errorCode, failCode } from './helpers';

import type { Environment } from '../types';

const apiUrl = 'https://xbl.io/';
const apiVersion = '/api/v2/';
const cacheTtl = 60 * 60 * 24 * 5; // 5 days

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
		};
		const url = new URL(apiUrl);
		url.pathname = apiVersion;
		url.pathname += payload.path;

		if (data.qs) {
			url.search = new URLSearchParams(data.qs).toString();
		}

		const response = await fetch(url.href, payload);

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

		return body;
	},
	parse(data: Record<string, any>) {
		let raw: Record<string, any> = {};
		let player: Record<string, any> = {};
		if (data?.profileUsers?.[0]) {
			raw = data.profileUsers[0];
			player = { id: raw.id, meta: {} };
		}

		for (const setting of raw.settings) {
			if (helpers.map[setting.id as keyof typeof helpers.map]) {
				player[helpers.map[setting.id as keyof typeof helpers.map]] =
					setting.value;
			} else {
				player.meta[camelCase(setting.id)] = setting.value;
			}
		}

		delete player.meta.gameDisplayPicRaw; // unneeded

		// ensure a username is defined
		if (!player.username && player.meta.realName) {
			player.username = player.meta.realName;
		}

		// set avatar
		player.avatar = `https://avatar-ssl.xboxlive.com/avatar/${player.username}/avatarpic-l.png`;

		return player;
	},
	map: {
		Gamertag: 'username',
	},
};

const lookup = async function lookup(request: Request, env: Environment) {
	const url = new URL(request.url);
	const xuid = url.pathname.split('/').pop(); // get last segment of URL pathname
	const isNumber = xuid !== undefined && !Number.isNaN(Number.parseInt(xuid));
	let returnData: Record<string, unknown> = {};
	let data;
	if (isNumber) {
		// lookup by ID
		returnData.id = xuid;
		data = await helpers.request({
			path: `account/${xuid}`,
			headers: {
				'X-Authorization': env.XBOX_APIKEY,
			},
		});
	} else {
		// lookup by username
		data = await helpers.request({
			path: 'friends/search',
			qs: {
				gt: xuid || '',
			},
			headers: {
				'X-Authorization': env.XBOX_APIKEY,
			},
		});
	}
	// parse the response data, and merge it with the existing returnData
	returnData = { ...helpers.parse(data), ...returnData };
	writeDataPoint(env, request, { type: 'xbox' });
	return { player: returnData };
};

export default lookup;
