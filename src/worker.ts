import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { writeDataPoint } from './libs/analytics';
import * as helpers from './libs/helpers';
import hytaleLookup from './libs/hytale';
import minecraftLookup from './libs/minecraft';
import steamLookup from './libs/steam';
import xboxLookup from './libs/xbox';

import type { Environment, HonoEnv } from './types';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

const DEBUG = false;

const addHeaders = {
	'X-XSS-Protection': '1; mode=block',
	'X-Frame-Options': 'DENY',
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'strict-origin-when-cross-origin',
	'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
	'Feature-Policy': [
		'geolocation \'none\';',
		'midi \'none\';',
		'sync-xhr \'none\';',
		'microphone \'none\';',
		'camera \'none\';',
		'magnetometer \'none\';',
		'gyroscope \'none\';',
		'speaker \'none\';',
		'fullscreen \'none\';',
		'payment \'none\';',
	].join(' '),
	'Content-Security-Policy': [
		'default-src \'self\';',
		'script-src \'self\' analytics.nodecraft.com cdnjs.cloudflare.com static.cloudflareinsights.com;',
		'style-src \'self\' \'unsafe-inline\' fonts.googleapis.com;',
		'img-src \'self\' data: analytics.nodecraft.com nodecraft.com;',
		'child-src \'none\';',
		'font-src \'self\' fonts.gstatic.com;',
		'connect-src \'self\' analytics.nodecraft.com;',
		'prefetch-src \'none\';',
		'object-src \'none\';',
		'form-action \'none\';',
		'frame-ancestors \'none\';',
		'upgrade-insecure-requests;',
	].join(' '),
} as const;

const apiHeader = {
	'content-type': 'application/json; charset=utf-8',
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, OPTIONS',
	'Cache-Control': 'public, max-age=300', // Cache errors for 5 minutes
};

class copyrightUpdate {
	buffer?: string;
	element(element: Element) {
		this.buffer = '';
		// eslint-disable-next-line unicorn/prefer-dom-node-dataset
		element.setAttribute('data-rewritten', 'true');
	}
	text(text: Text) {
		this.buffer += text.text; // concatenate new text with existing text buffer
		if (text.lastInTextNode) {
			// this is the last bit of text in the chunk. Search and replace text
			text.replace(String(new Date().getFullYear()));
			this.buffer = '';
		} else {
			// This wasn't the last text chunk, and we don't know if this chunk will
			// participate in a match. We must remove it so the client doesn't see it
			text.remove();
		}
	}
}
const filesRegex = /(.*\.(ac3|avi|bmp|br|bz2|css|cue|dat|doc|docx|dts|eot|exe|flv|gif|gz|htm|html|ico|img|iso|jpeg|jpg|js|json|map|mkv|mp3|mp4|mpeg|mpg|ogg|pdf|png|ppt|pptx|qt|rar|rm|svg|swf|tar|tgz|ttf|txt|wav|webp|webm|webmanifest|woff|woff2|xls|xlsx|xml|zip))$/;

const app = new Hono<HonoEnv>();

// CORS middleware for all routes
app.use('*', cors({
	origin: '*',
	allowMethods: ['GET', 'OPTIONS'],
	allowHeaders: ['*'],
	maxAge: 86400,
}));

// middleware to set start time and parse URL once
app.use('*', async (ctx, next) => {
	ctx.set('startTime', new Date());
	ctx.set('url', new URL(ctx.req.url));
	await next();
});

// static asset serving middleware (for non-API routes)
app.use('*', async (ctx, next) => {
	const url = ctx.get('url');

	// Skip if this is an API route
	if (url.pathname.startsWith('/api')) {
		await next();
		return;
	}

	// Try to get asset from KV
	let asset = null;
	try {
		asset = await ctx.env.ASSETS.fetch(ctx.req.raw);
	} catch {
		// nothing to do. Fall through to next middleware and eventual 404
	}

	if (asset) {
		// make mutable
		asset = new Response(asset.body, asset);
		// set longer cache time for static files like images
		if (filesRegex.test(url.pathname)) {
			// set cache control to 30 days
			asset.headers.set('Cache-Control', 'public, max-age=2592000');
		}
		// we have something from Workers Sites. Use it
		if (asset.headers.get('content-type') === 'text/html') {
			// set security headers on html pages
			for (const [name, value] of Object.entries(addHeaders)) {
				asset.headers.set(name, value);
			}
		}
		// override content type header for favicon svg
		if (url.pathname === '/favicon.svg') {
			asset.headers.set('content-type', 'image/svg+xml');
		}

		if (url.pathname === '/') {
			const transformed = new HTMLRewriter()
				.on('span#copyrightDate', new copyrightUpdate())
				.transform(asset);
			return transformed;
		}
		return asset;
	}

	// No asset found, continue to next handler
	await next();
});

// Edge caching middleware for API routes
app.use('/api/*', async (ctx, next) => {
	const url = ctx.get('url');
	const cache = caches.default; // Cloudflare edge caching

	let type = 'unknown';
	if (url.pathname.includes('/player/hytale')) {
		type = 'hytale';
	} else if (url.pathname.includes('/player/minecraft')) {
		type = 'minecraft';
	} else if (url.pathname.includes('/player/steam')) {
		type = 'steam';
	} else if (url.pathname.includes('/player/xbox')) {
		type = 'xbox';
	}

	const lookupQuery = url.pathname.split('/').pop() || '';
	ctx.set('lookupQuery', lookupQuery);

	// Normalize cache key: lowercase the query for case-insensitive lookups (e.g., Minecraft usernames)
	const normalizedUrl = new URL(url);
	normalizedUrl.pathname = normalizedUrl.pathname.toLowerCase();
	const cacheKey = normalizedUrl.toString();

	const response = await cache.match(cacheKey); // try to find match for this request in the edge cache
	if (process.env.NODE_ENV !== 'development' && response) {
		// use cache found on Cloudflare edge. Set X-Worker-Cache header for helpful debug
		const newHdrs = new Headers(response.headers);
		newHdrs.set('X-Worker-Cache', 'true');

		writeDataPoint(ctx, {
			cached: true,
			type,
			status: response.status,
		});
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: newHdrs,
		});
	}

	// Store type for use in error handler
	ctx.set('type', type);

	await next();

	// Cache the response after handler completes
	if (ctx.res) {
		const primaryCacheResponse = ctx.res.clone();
		const jsonParseResponse = ctx.res.clone();

		// Cache primary URL (using normalized cache key)
		ctx.executionCtx.waitUntil(cache.put(cacheKey, primaryCacheResponse));

		// if querying for username, store a cache for the ID of this player too
		ctx.executionCtx.waitUntil((async () => {
			try {
				const lookupQuery = ctx.get('lookupQuery');
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const responseData = await jsonParseResponse.json<any>();
				if (responseData?.data?.player?.id && responseData?.data?.player?.id !== lookupQuery) {
					const secondaryUrl = new URL(cacheKey);
					secondaryUrl.pathname = secondaryUrl.pathname.slice(0, secondaryUrl.pathname.length - lookupQuery.toLowerCase().length) + responseData.data.player.id.toLowerCase();
					// Reconstruct response from parsed data (avoids upfront clone)
					const secondaryCacheResponse = new Response(JSON.stringify(responseData), {
						status: ctx.res.status,
						headers: ctx.res.headers,
					});
					await cache.put(secondaryUrl.toString(), secondaryCacheResponse);
				}
			} catch (err) {
				// we tried to cache more. No problem if this doesn't work
				console.error('Secondary cache error:', err);
			}
		})());
	}
});

app.onError((err, ctx) => {
	console.error('ERROR', err);

	const type = ctx.get('type') || 'unknown';

	let responseData = helpers.code('api.unknown_error') as Record<
		string,
		unknown
	>;
	if (err instanceof helpers.failCode || err instanceof helpers.errorCode) {
		const { message, code, data } = err;
		responseData = { message, code: code, data };
		responseData.success = false;
		responseData.error = err instanceof helpers.errorCode;
	}

	// set status code appropriately
	let status: ContentfulStatusCode = 400;
	if ('statusCode' in err && err?.statusCode && typeof err.statusCode === 'number') {
		// @ts-expect-error errors aren't properly typed
		status = err.statusCode;
	} else if (responseData.error) {
		status = 500;
	}
	// handle `api.404` code specifically as a 404 status
	if ('code' in err && err.code === 'api.404') {
		status = 404;
	}

	writeDataPoint(ctx, {
		type,
		// @ts-expect-error errors aren't properly typed
		error: err.code || 'unknown',
		status,
	});

	const errorResponse = ctx.json(responseData, status, apiHeader);

	if (ctx.req.url.includes('/api/')) {
		const cache = caches.default;
		// normalize cache key for consistency with middleware
		const url = ctx.get('url');
		const normalizedUrl = new URL(url);
		normalizedUrl.pathname = normalizedUrl.pathname.toLowerCase();
		ctx.executionCtx.waitUntil(cache.put(normalizedUrl.toString(), errorResponse.clone()));
	}

	return errorResponse;
});

// Not found handler (404) - throw to onError for consistent analytics and caching
app.notFound(() => {
	throw new helpers.failCode('api.404', { statusCode: 404 });
});

// API routes
app.get('/api/player/hytale/:query', hytaleLookup);
app.get('/api/player/minecraft/:query', minecraftLookup);
app.get('/api/player/steam/:query', steamLookup);
app.get('/api/player/xbox/:query', xboxLookup);

export default {
	async fetch(request, env, ctx): Promise<Response> {
		try {
			return app.fetch(request, env, ctx);
		} catch (err) {
			if (DEBUG) {
				// @ts-expect-error errors aren't properly typed
				return new Response(err.message || err.toString(), {
					status: 500,
				});
			}
			const responseData = helpers.code('api.internal_error');
			return new Response(JSON.stringify(responseData), {
				status: 500,
				headers: apiHeader,
			});
		}
	},

	// refresh Hytale token periodically to avoid expiration
	async scheduled(event, env, ctx): Promise<void> {
		const id = env.HYTALE_TOKEN_MANAGER.idFromName('singleton');
		const tokenManager = env.HYTALE_TOKEN_MANAGER.get(id);

		const result = await tokenManager.proactiveRefresh();
		console.log(`Hytale token refresh cron: ${result}`);
	},
} satisfies ExportedHandler<Environment>;

// durable object class for hytale token management
export { HytaleTokenManager } from './libs/hytale-token-manager';

// container DO class for hytale proxy
export { HytaleProxyContainer } from './libs/hytale-proxy-container';
