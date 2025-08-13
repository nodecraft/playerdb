import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import { config } from 'dotenv';

config({ path: '.dev.vars' });

export default defineWorkersConfig({
	test: {
		testTimeout: 10000,
		poolOptions: {
			workers: {
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
			},
		},
	},
});
