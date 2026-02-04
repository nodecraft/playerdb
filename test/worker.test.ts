import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import worker from '../src/worker';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('worker requests', () => {
	it('responds with html for root path', async () => {
		const request = new IncomingRequest('http://localhost/');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toEqual(
			'text/html; charset=utf-8',
		);

		// consume body to ensure no EBUSY errors
		await response.text();
	});
	it('responds with 404 for unknown path', async () => {
		const request = new IncomingRequest('http://localhost/404');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(404);

		// consume body to ensure no EBUSY errors
		await response.text();
	});
});

describe('minecraft api', () => {
	it('responds with expected response for username', async () => {
		const request = new IncomingRequest(
			'http://localhost/api/player/minecraft/CherryJimbo',
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		const json = await response.json<any>();
		expect(response.status).toBe(200);
		expect(response.headers.get('cf-cache-status')).toEqual(null);
		expect(json.success).toBe(true);
		expect(json.code).toEqual('player.found');
		expect(json.data).toHaveProperty('player');
		expect(json.data.player.username).toEqual('CherryJimbo');
		expect(json.data.player.id).toEqual('ef613480-5b62-44e4-a446-7fbe85d65513');
		expect(json.data.player.raw_id).toEqual('ef6134805b6244e4a4467fbe85d65513');
		expect(json.data.player.avatar).toEqual(
			'https://crafthead.net/avatar/ef6134805b6244e4a4467fbe85d65513',
		);
		expect(json.data.player.skin_texture).toEqual(
			'https://textures.minecraft.net/texture/9d2e80355eed693e3f0485893ef04ff6a507f3aab33f2bedb48cef56e30f67d0',
		);

		// cape_texture is only present if the player has a cape
		if (json.data.player.cape_texture !== undefined) {
			expect(json.data.player.cape_texture).toEqual(expect.any(String));
			expect(json.data.player.cape_texture).toMatch(/^https:\/\/textures\.minecraft\.net/);
		}

		expect(json.data.player.properties).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: 'textures',
					value: expect.any(String),
					signature: expect.any(String),
				}),
			]),
		);
		expect(json.data.player.name_history).toEqual(expect.any(Array));

		// make request again, should now be cached
		const ctx2 = createExecutionContext();
		const response2 = await worker.fetch(request, env, ctx2);
		await waitOnExecutionContext(ctx2);
		expect(response2.status).toBe(200);
		expect(response2.headers.get('cf-cache-status')).toEqual('HIT');
		// consume body to ensure no EBUSY errors
		await response2.text();
	});

	it('responds with expected response for uuid', async () => {
		const request = new IncomingRequest(
			'http://localhost/api/player/minecraft/ef613480-5b62-44e4-a446-7fbe85d65513',
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		const json = await response.json<any>();
		expect(response.status).toBe(200);
		expect(json.success).toBe(true);
		expect(json.code).toEqual('player.found');
		expect(json.data).toHaveProperty('player');
		expect(json.data.player.username).toEqual('CherryJimbo');
		expect(json.data.player.id).toEqual('ef613480-5b62-44e4-a446-7fbe85d65513');
		expect(json.data.player.raw_id).toEqual('ef6134805b6244e4a4467fbe85d65513');
		expect(json.data.player.avatar).toEqual(
			'https://crafthead.net/avatar/ef6134805b6244e4a4467fbe85d65513',
		);
		expect(json.data.player.skin_texture).toEqual(
			'https://textures.minecraft.net/texture/9d2e80355eed693e3f0485893ef04ff6a507f3aab33f2bedb48cef56e30f67d0',
		);

		// cape_texture is only present if the player has a cape
		if (json.data.player.cape_texture !== undefined) {
			expect(json.data.player.cape_texture).toEqual(expect.any(String));
			expect(json.data.player.cape_texture).toMatch(/^https:\/\/textures\.minecraft\.net/);
		}

		expect(json.data.player.properties).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: 'textures',
					value: expect.any(String),
					signature: expect.any(String),
				}),
			]),
		);
		expect(json.data.player.name_history).toEqual(expect.any(Array));
	});

	it('responds with expected response for raw uuid', async () => {
		const request = new IncomingRequest(
			'http://localhost/api/player/minecraft/ef6134805b6244e4a4467fbe85d65513',
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		const json = await response.json<any>();
		expect(response.status).toBe(200);
		expect(json.success).toBe(true);
		expect(json.code).toEqual('player.found');
		expect(json.data).toHaveProperty('player');
		expect(json.data.player.username).toEqual('CherryJimbo');
		expect(json.data.player.id).toEqual('ef613480-5b62-44e4-a446-7fbe85d65513');
		expect(json.data.player.raw_id).toEqual('ef6134805b6244e4a4467fbe85d65513');
		expect(json.data.player.avatar).toEqual(
			'https://crafthead.net/avatar/ef6134805b6244e4a4467fbe85d65513',
		);
		expect(json.data.player.skin_texture).toEqual(
			'https://textures.minecraft.net/texture/9d2e80355eed693e3f0485893ef04ff6a507f3aab33f2bedb48cef56e30f67d0',
		);

		// cape_texture is only present if the player has a cape
		if (json.data.player.cape_texture !== undefined) {
			expect(json.data.player.cape_texture).toEqual(expect.any(String));
			expect(json.data.player.cape_texture).toMatch(/^https:\/\/textures\.minecraft\.net/);
		}

		expect(json.data.player.properties).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: 'textures',
					value: expect.any(String),
					signature: expect.any(String),
				}),
			]),
		);
		expect(json.data.player.name_history).toEqual(expect.any(Array));
	});

	it('responds for unknown player', async () => {
		const request = new IncomingRequest(
			'http://localhost/api/player/minecraft/cherryjimbo-nope',
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		const json = await response.json<any>();
		expect(response.status).toBe(400);
		expect(json.success).toBe(false);
		expect(json.code).toEqual('minecraft.invalid_username');
	});

	it('responds with 400 for invalid username', async () => {
		const request = new IncomingRequest(
			'http://localhost/api/player/minecraft/cherryjimbo@example.com',
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		const json = await response.json<any>();
		expect(response.status).toBe(400);
		expect(json.success).toBe(false);
		expect(json.code).toEqual('minecraft.invalid_username');
	});

	it('responds with cape_texture for player with cape', async () => {
		// Dinnerbone is a Mojang developer who has a Mojang cape
		const request = new IncomingRequest(
			'http://localhost/api/player/minecraft/Dinnerbone',
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		const json = await response.json<any>();
		expect(response.status).toBe(200);
		expect(json.success).toBe(true);
		expect(json.code).toEqual('player.found');
		expect(json.data).toHaveProperty('player');
		expect(json.data.player.username).toEqual('Dinnerbone');
		expect(json.data.player).toHaveProperty('skin_texture');
		expect(json.data.player).toHaveProperty('cape_texture');
		expect(json.data.player.cape_texture).toEqual(expect.any(String));
		expect(json.data.player.cape_texture).toMatch(/^https:\/\/textures\.minecraft\.net/);
	});
});

describe.skipIf(!env.STEAM_APIKEY)('steam api', () => {
	it('responds with expected response for vanity url', async (context) => {
		const request = new IncomingRequest(
			'http://localhost/api/player/steam/james_ross',
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		const json = await response.json<any>();
		if (response.status === 429) {
			// ignore tests if rate limited for now
			context.skip();
			return;
		}
		expect(response.status).toBe(200);
		expect(response.headers.get('cf-cache-status')).toEqual(null);
		expect(json.success).toBe(true);
		expect(json.code).toEqual('player.found');
		expect(json.data).toHaveProperty('player');
		expect(json.data.player.id).toEqual('76561198047699606');
		expect(json.data.player.username).toEqual('James');
		expect(json.data.player).toHaveProperty('avatar');
		expect(json.data.player).toHaveProperty('meta');

		// make request again, should now be cached
		const ctx2 = createExecutionContext();
		const response2 = await worker.fetch(request, env, ctx2);
		await waitOnExecutionContext(ctx2);
		expect(response2.status).toBe(200);
		expect(response2.headers.get('cf-cache-status')).toEqual('HIT');

		// consume body to ensure no EBUSY errors
		await response2.text();
	});

	it('responds with expected response for steam2id', async (context) => {
		const request = new IncomingRequest(
			'http://localhost/api/player/steam/STEAM_0:0:43716939',
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		const json = await response.json<any>();
		if (response.status === 429) {
			// ignore tests if rate limited for now
			context.skip();
			return;
		}
		expect(response.status).toBe(200);
		expect(json.success).toBe(true);
		expect(json.code).toEqual('player.found');
		expect(json.data).toHaveProperty('player');
		expect(json.data.player.id).toEqual('76561198047699606');
		expect(json.data.player.username).toEqual('James');
		expect(json.data.player).toHaveProperty('avatar');
		expect(json.data.player).toHaveProperty('meta');
	});

	it('responds with expected response for steam3id', async (context) => {
		const request = new IncomingRequest(
			'http://localhost/api/player/steam/[U:1:87433878]',
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		const json = await response.json<any>();
		if (response.status === 429) {
			// ignore tests if rate limited for now
			context.skip();
			return;
		}
		expect(response.status).toBe(200);
		expect(json.success).toBe(true);
		expect(json.code).toEqual('player.found');
		expect(json.data).toHaveProperty('player');
		expect(json.data.player.id).toEqual('76561198047699606');
		expect(json.data.player.username).toEqual('James');
		expect(json.data.player).toHaveProperty('avatar');
		expect(json.data.player).toHaveProperty('meta');
	});

	it('responds with expected response for steam64id', async (context) => {
		const request = new IncomingRequest(
			'http://localhost/api/player/steam/76561198047699606',
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		const json = await response.json<any>();
		if (response.status === 429) {
			// ignore tests if rate limited for now
			context.skip();
			return;
		}
		expect(response.status).toBe(200);
		expect(json.success).toBe(true);
		expect(json.code).toEqual('player.found');
		expect(json.data).toHaveProperty('player');
		expect(json.data.player.id).toEqual('76561198047699606');
		expect(json.data.player.username).toEqual('James');
		expect(json.data.player).toHaveProperty('avatar');
		expect(json.data.player).toHaveProperty('meta');
	});
});

describe.skipIf(!env.XBOX_APIKEY)('xbox api', () => {
	it('responds with expected response for gamertag', async (context) => {
		const request = new IncomingRequest(
			'http://localhost/api/player/xbox/Jimboodude',
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		const json = await response.json<any>();
		if (response.status === 429 || json?.data?.status === 429) {
			// ignore tests if rate limited for now
			context.skip();
			return;
		}
		expect(response.status).toBe(200);
		expect(response.headers.get('cf-cache-status')).toEqual(null);
		expect(json.success).toBe(true);
		expect(json.code).toEqual('player.found');
		expect(json.data).toHaveProperty('player');
		expect(json.data.player.id).toEqual('2533274818672320');
		expect(json.data.player.username).toEqual('Jimboodude');
		expect(json.data.player.avatar).toMatch(/^https?:\/\//);
		expect(json.data.player.avatar).not.toContain('mode=Padding');
		expect(json.data.player).toHaveProperty('meta');

		// make request again, should now be cached
		const ctx2 = createExecutionContext();
		const response2 = await worker.fetch(request, env, ctx2);
		await waitOnExecutionContext(ctx2);
		expect(response2.status).toBe(200);
		expect(response2.headers.get('cf-cache-status')).toEqual('HIT');

		// consume body to ensure no EBUSY errors
		await response2.text();
	});

	it('responds with expected response for xuid', async (context) => {
		const request = new IncomingRequest(
			'http://localhost/api/player/xbox/2533274818672320',
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		const json = await response.json<any>();
		if (response.status === 429 || json?.data?.status === 429) {
			// ignore tests if rate limited for now
			context.skip();
			return;
		}
		expect(response.status).toBe(200);
		expect(json.success).toBe(true);
		expect(json.code).toEqual('player.found');
		expect(json.data).toHaveProperty('player');
		expect(json.data.player.id).toEqual('2533274818672320');
		expect(json.data.player.username).toEqual('Jimboodude');
		expect(json.data.player).toHaveProperty('avatar');
		expect(json.data.player).toHaveProperty('meta');
	});

	it('responds for invalid xuid', async (context) => {
		const request = new IncomingRequest(
			'http://localhost/api/player/xbox/2533274818672320z',
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		const json = await response.json<any>();
		if (response.status === 429 || json?.data?.status === 429) {
			// ignore tests if rate limited for now
			context.skip();
			return;
		}
		expect(response.status).toBe(500);
		expect(json.success).toBe(false);
		expect(json.code).toEqual('xbox.bad_response_code');
	});

	it('responds for unknown gamertag', async (context) => {
		const request = new IncomingRequest(
			'http://localhost/api/player/xbox/thisuserdoesnotexist99999',
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		const json = await response.json<any>();
		if (response.status === 429 || json?.data?.status === 429) {
			// ignore tests if rate limited for now
			context.skip();
			return;
		}
		expect(json.success).toBe(false);
		// API may return not_found (400) or bad_response_code (500) depending on xbl.io behavior
		expect([400, 500]).toContain(response.status);
		expect(['xbox.not_found', 'xbox.bad_response_code']).toContain(json.code);
	});
});

// TODO: investigate tests hanging with durable object usage
describe.skip('hytale api', () => {
	it('responds with expected response for profile uuid', async () => {
		const request = new IncomingRequest(
			'http://localhost/api/player/hytale/e270fb8d-fdf9-4edc-9f82-ad2dca9a4ba2',
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		const json = await response.json<any>();
		expect(response.status).toBe(200);
		expect(response.headers.get('cf-cache-status')).toEqual(null);
		expect(json.success).toBe(true);
		expect(json.code).toEqual('player.found');
		expect(json.data).toHaveProperty('player');
		expect(json.data.player.id).toEqual('e270fb8d-fdf9-4edc-9f82-ad2dca9a4ba2');
		expect(json.data.player.username).toEqual('cherryjimbo');
		expect(json.data.player).toHaveProperty('avatar');
		expect(json.data.player).toHaveProperty('meta');
		// make request again, should now be cached
		const ctx2 = createExecutionContext();
		const response2 = await worker.fetch(request, env, ctx2);
		await waitOnExecutionContext(ctx2);
		expect(response2.status).toBe(200);
		expect(response2.headers.get('cf-cache-status')).toEqual('HIT');
		// consume body to ensure no EBUSY errors
		await response2.text();
	});

	it('responds with expected response for username', async () => {
		const request = new IncomingRequest(
			'http://localhost/api/player/hytale/cherryjimbo',
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		const json = await response.json<any>();
		expect(response.status).toBe(200);
		expect(json.success).toBe(true);
		expect(json.code).toEqual('player.found');
		expect(json.data).toHaveProperty('player');
		expect(json.data.player.id).toEqual('e270fb8d-fdf9-4edc-9f82-ad2dca9a4ba2');
		expect(json.data.player.username).toEqual('cherryjimbo');
		expect(json.data.player).toHaveProperty('avatar');
		expect(json.data.player).toHaveProperty('meta');
	});

	it('responds for unknown profile uuid', async () => {
		const request = new IncomingRequest(
			'http://localhost/api/player/hytale/00000000-0000-0000-0000-000000000000',
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		const json = await response.json<any>();
		expect(response.status).toBe(400);
		expect(json.success).toBe(false);
		expect(json.code).toEqual('hytale.not_found');
	});

	it('responds for invalid profile uuid', async () => {
		const request = new IncomingRequest(
			'http://localhost/api/player/hytale/invalid-uuid-format',
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		const json = await response.json<any>();
		expect(response.status).toBe(400);
		expect(json.success).toBe(false);
		expect(json.code).toEqual('hytale.invalid_identifier');
	});
});
