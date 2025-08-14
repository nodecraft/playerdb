export interface Environment {
	ASSETS: Fetcher;
	PLAYERDB_CACHE: KVNamespace;
	PLAYERDB_ANALYTICS?: AnalyticsEngineDataset;

	XBOX_APIKEY: string;
	STEAM_APIKEY: string;
	STEAM_APIKEY2?: string;
	STEAM_APIKEY3?: string;
	STEAM_APIKEY4?: string;
	NODECRAFT_API_KEY?: string;
	BYPASS_CACHE?: string;

	startTime?: Date;
}
