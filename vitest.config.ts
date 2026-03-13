import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

config({ path: '.dev.vars' });

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: {
				configPath: './wrangler.toml',
				environment: 'production',
			},
			miniflare: {
				bindings: {
					XBOX_APIKEY: process.env.XBOX_APIKEY || '',
					STEAM_APIKEY: process.env.STEAM_APIKEY || '',
				},
			},
		}),
	],
	test: {
		testTimeout: 10000,
	},
});
