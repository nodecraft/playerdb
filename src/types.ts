import type { HytaleProxyContainer } from './libs/hytale-proxy-container';
import type { HytaleTokenManager } from './libs/hytale-token-manager';

// Change this to reset the token manager DO (creates a fresh instance with empty storage)
export const HYTALE_TOKEN_MANAGER_ID = 'singleton-2026-03-04';

export interface Environment {
	ASSETS: Fetcher;
	PLAYERDB_CACHE: KVNamespace;
	PLAYERDB_ANALYTICS?: AnalyticsEngineDataset;
	HYTALE_TOKEN_MANAGER: DurableObjectNamespace<HytaleTokenManager>;
	HYTALE_PROXY: DurableObjectNamespace<HytaleProxyContainer>;

	XBOX_APIKEY: string;
	STEAM_APIKEY: string;
	STEAM_APIKEY2?: string;
	STEAM_APIKEY3?: string;
	STEAM_APIKEY4?: string;
	NODECRAFT_API_KEY?: string;
	HYTALE_REFRESH_TOKEN?: string;
	HYTALE_PROFILE_UUID?: string;
	HYTALE_SESSION_POOL_MIN?: string;
	HYTALE_SESSION_POOL_MAX?: string;
	BYPASS_CACHE?: string;
}

export type HonoEnv = {
	Bindings: Environment;
	Variables: {
		startTime: Date;
		type: string;
		lookupQuery: string;
		url: URL;
	};
};
