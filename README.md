# [PlayerDB.co](https://playerdb.co)

[PlayerDB.co](https://playerdb.co) is a highly scalable, serverless player info fetching and caching solution built on [Cloudflare Workers](https://workers.cloudflare.com).
It runs on any of Cloudflare's hundreds of datacenters worldwide with minimal latency.

For most users, you will simply want to use the [API](https://playerdb.co) and not run this or deploy this repository yourself. Please ensure when using the API that you specify a reasonable `User-Agent` header.

## Development

Create a `.dev.vars` file containing the following:

```
STEAM_APIKEY=XXXXXXXXXXXXXXXXXXXXXXXX
XBOX_APIKEY=XXXXXXXXXXXXXXXXXXXXXXXX
```

These are your API keys for the Steam and Xbox APIs, respectively, and are needed for the app to function. You can obtain them from the respective developer portals:
- [Steam API Key](https://steamcommunity.com/dev/apikey)
- [Xbox API Key](https://xbl.io/) (third party service, requires registration)

If you do not have these keys, the app will still run, but it will not be able to fetch player data from Steam or Xbox. See the "running specific tests" section below for more information on how to run tests without these keys.

### Running Locally
To run the app locally, install dependencies with `npm ci`, and you can then use the following commands:

```bash
npm run dev
```

### Testing
To run tests, use the following command:
```bash
npm run test
```
#### Running specific tests
This can be useful if you want to test specific functionality without running the entire test suite, if you don't have a Steam or Xbox API key. For example, if you want to run tests solely related to Minecraft, you can use:

```bash
npx vitest --testNamePattern="minecraft"
```

