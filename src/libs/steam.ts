import steamid from 'steamid';

import { writeDataPoint } from './analytics';
import { errorCode, failCode } from './helpers';

import type { Environment } from '../types';

const apiUrl = 'https://api.steampowered.com/';
const cacheTtl = 60 * 60 * 24 * 5; // 5 days

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
		const response = await fetch(url.href, {
			method: 'GET',
			cf: {
				cacheEverything: true,
				cacheTtl,
			},
		});

		if (response.status === 429) {
			throw new errorCode('steam.rate_limited', { statusCode: 429 });
		}

		if (response.status !== 200) {
			console.log(
				'Steam API request failed:',
				response.status,
				response.statusText,
				url.href,
			);
			throw new errorCode('steam.api_failure');
		}

		const contentType = response.headers.get('content-type');
		if (!contentType || !contentType.includes('json')) {
			throw new errorCode('steam.non_json', {
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
			throw new failCode('steam.invalid_id');
		}
		body.request_type = 'http';
		return body;
	},
};

const lookup = async function lookup(request: Request, env: Environment) {
	const url = new URL(request.url);
	let steamID = url.pathname.split('/').pop() || ''; // get last segment of URL pathname

	let id = null;
	const returnData: Record<string, any> = { meta: {} };

	const APIKeys = [
		env.STEAM_APIKEY,
		env.STEAM_APIKEY2,
		env.STEAM_APIKEY3,
		env.STEAM_APIKEY4,
	].filter(Boolean);

	const useAPIKey = APIKeys[Math.floor(Math.random() * APIKeys.length)];

	// first try to resolve vanity URL. Wrap this in a try/catch because we don't mind if it fails
	if (
		!steamID.startsWith('STEAM_') &&
		!steamID.startsWith('7656119') &&
		!steamID.startsWith('U:') &&
		!steamID.startsWith('[U:')
	) {
		try {
			const vanityURLData = await helpers.request({
				path: 'ISteamUser/ResolveVanityURL/v1',
				qs: {
					key: useAPIKey as string,
					vanityurl: steamID,
				},
			});
			if (vanityURLData?.response?.steamid) {
				steamID = vanityURLData.response.steamid;
			}
		} catch {
			// do nothing, we probably have a real ID already
		}
	}

	// then lookup by SteamID
	try {
		id = new steamid(steamID);
	} catch (err) {
		// @ts-expect-error pass-through error badly
		throw new failCode('steam.invalid_id', err);
	}
	if (!id.isValid()) {
		throw new failCode('steam.invalid_id');
	}
	returnData.id = id.getSteamID64();
	returnData.meta.steam2id = id.steam2();
	returnData.meta.steam2id_new = id.steam2(true);
	returnData.meta.steam3id = id.steam3();
	returnData.meta.steam64id = returnData.id;

	// then getPlayerSummaries
	const playerSummaries = await helpers.request({
		path: 'ISteamUser/GetPlayerSummaries/v2',
		qs: {
			key: useAPIKey as string,
			steamids: returnData.id,
		},
	});
	if (
		!playerSummaries?.response?.players ||
		playerSummaries.response.players.length === 0
	) {
		throw new failCode('steam.invalid_id');
	}
	const playerSummary = playerSummaries.response.players[0];
	returnData.avatar = playerSummary.avatarfull;
	returnData.username = playerSummary.personaname;

	// attach everything else from Steam to meta, merging with existing
	returnData.meta = {
		...returnData.meta,
		...playerSummaries.response.players[0],
	};

	writeDataPoint(env, request, {
		type: 'steam',
		request_type: playerSummary.request_type,
	});
	return { player: returnData };
};

export default lookup;
