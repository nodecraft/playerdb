import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
} from 'vitest';

import worker from '../src/worker';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const quotaKey = 'xbox-quota-exhausted';
const realFetch = globalThis.fetch;

type Route = { match: (url: string) => boolean; reply: () => Response; };

let routes: Route[] = [];
let upstreamCalls: string[] = [];

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = input instanceof Request ? input.url : String(input);
	if (!url.startsWith('https://xbl.io')) {
		return realFetch(input as RequestInfo, init);
	}
	upstreamCalls.push(url);
	const route = routes.find(candidate => candidate.match(url));
	if (!route) {
		throw new Error(`unexpected upstream call: ${url}`);
	}
	return route.reply();
}) as typeof fetch;

afterAll(() => {
	globalThis.fetch = realFetch;
});

function quotaJson(body: unknown, remaining: number) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: {
			'content-type': 'application/json;charset=utf-8',
			'x-ratelimit-limit': '150',
			'x-ratelimit-remaining': String(remaining),
		},
	});
}

function profileBody(gamertag: string, id = '2533274800000001') {
	return {
		code: 200,
		content: {
			profileUsers: [{ id, settings: [{ id: 'Gamertag', value: gamertag }] }],
		},
	};
}

async function call(path: string) {
	const request = new IncomingRequest(`http://localhost${path}`, {
		headers: { 'User-Agent': 'smoke-test' },
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	const text = await response.text();
	await waitOnExecutionContext(ctx);
	return { response, text };
}

describe('xbox throughput hardening', () => {
	beforeEach(async () => {
		routes = [];
		upstreamCalls = [];
		await env.PLAYERDB_CACHE.delete(quotaKey);
	});
	afterEach(async () => {
		await env.PLAYERDB_CACHE.delete(quotaKey);
	});

	it('retries an underscored gamertag with spaces restored', async () => {
		routes.push(
			{
				match: url => url.includes('gt=Space_Man_A'),
				reply: () => quotaJson({ code: 400, content: { code: 28 } }, 140),
			},
			{
				match: url => url.includes('gt=Space+Man+A'),
				reply: () => quotaJson(profileBody('Space Man A'), 139),
			},
		);

		const { response, text } = await call('/api/player/xbox/Space_Man_A');
		const json = JSON.parse(text);

		expect(upstreamCalls).toHaveLength(2);
		expect(response.status).toBe(200);
		expect(json.data.player.username).toBe('Space Man A');
	});

	it('reports an upstream non-JSON throttle page as an uncached 429', async () => {
		routes.push({
			match: url => url.includes('gt=HtmlThrottled'),
			reply: () => new Response('<html>rate limited</html>', {
				status: 200,
				headers: { 'content-type': 'text/html' },
			}),
		});

		const { response, text } = await call('/api/player/xbox/HtmlThrottled');

		expect(response.status).toBe(429);
		expect(response.headers.get('Retry-After')).toBe('60');
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(JSON.parse(text).code).toBe('xbox.rate_limited');
	});

	it('trips the shared gate when upstream reports the quota spent', async () => {
		routes.push({
			match: url => url.includes('gt=LastCall'),
			reply: () => quotaJson(profileBody('LastCall'), 0),
		});

		const { response } = await call('/api/player/xbox/LastCall');

		expect(response.status).toBe(200);
		expect(await env.PLAYERDB_CACHE.get(quotaKey)).not.toBeNull();
	});

	it('refuses to spend upstream calls while the gate is closed', async () => {
		await env.PLAYERDB_CACHE.put(quotaKey, String(Date.now()), { expirationTtl: 900 });
		routes.push({
			match: url => url.includes('gt=GatedOff'),
			reply: () => quotaJson(profileBody('GatedOff'), 100),
		});

		const { response } = await call('/api/player/xbox/GatedOff');

		expect(response.status).toBe(429);
		// the 1% probe can leak a single call, but the gate must not pass traffic through
		expect(upstreamCalls.length).toBeLessThanOrEqual(1);
	});

	it('serves a stale profile instead of failing while the gate is closed', async () => {
		const eightDaysAgo = Date.now() - (8 * 24 * 60 * 60 * 1000);
		await env.PLAYERDB_CACHE.put(
			'xbox-profile-staleguy',
			JSON.stringify({ id: '2533274800000009', username: 'StaleGuy', cached_at: eightDaysAgo }),
		);
		await env.PLAYERDB_CACHE.put(quotaKey, String(Date.now()), { expirationTtl: 900 });

		const { response, text } = await call('/api/player/xbox/StaleGuy');

		expect(response.status).toBe(200);
		expect(response.headers.get('X-Playerdb-Stale')).toBe('true');
		expect(JSON.parse(text).data.player.username).toBe('StaleGuy');
	});

	it('serves a stale profile when upstream errors', async () => {
		const eightDaysAgo = Date.now() - (8 * 24 * 60 * 60 * 1000);
		await env.PLAYERDB_CACHE.put(
			'xbox-profile-brokenup',
			JSON.stringify({ id: '2533274800000010', username: 'BrokenUp', cached_at: eightDaysAgo }),
		);
		routes.push({
			match: url => url.includes('gt=BrokenUp'),
			reply: () => new Response(JSON.stringify({ code: 500 }), {
				status: 500,
				headers: { 'content-type': 'application/json' },
			}),
		});

		const { response, text } = await call('/api/player/xbox/BrokenUp');

		expect(response.status).toBe(200);
		expect(response.headers.get('X-Playerdb-Stale')).toBe('true');
		expect(JSON.parse(text).data.player.username).toBe('BrokenUp');
	});

	it('serves a fresh cached profile without touching upstream', async () => {
		await env.PLAYERDB_CACHE.put(
			'xbox-profile-freshguy',
			JSON.stringify({ id: '2533274800000011', username: 'FreshGuy', cached_at: Date.now() }),
		);

		const { response, text } = await call('/api/player/xbox/FreshGuy');

		expect(response.status).toBe(200);
		expect(upstreamCalls).toHaveLength(0);
		expect(response.headers.get('X-Playerdb-Stale')).toBeNull();
		expect(JSON.parse(text).data.player.username).toBe('FreshGuy');
	});
});
