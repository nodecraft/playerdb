import { writeDataPoint } from './libs/analytics';
import * as helpers from './libs/helpers';
import minecraftLookup from './libs/minecraft';
import Router from './libs/router';
import steamLookup from './libs/steam';
import xboxLookup from './libs/xbox';

import type { Environment } from './types';

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

const cacheTtl = 60 * 60 * 24 * 5; // 5 days

const apiHeader = {
	'content-type': 'application/json; charset=utf-8',
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, OPTIONS',
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
const filesRegex =
	/(.*\.(ac3|avi|bmp|br|bz2|css|cue|dat|doc|docx|dts|eot|exe|flv|gif|gz|htm|html|ico|img|iso|jpeg|jpg|js|json|map|mkv|mp3|mp4|mpeg|mpg|ogg|pdf|png|ppt|pptx|qt|rar|rm|svg|swf|tar|tgz|ttf|txt|wav|webp|webm|webmanifest|woff|woff2|xls|xlsx|xml|zip))$/;

// setup router for each service handler. Create this outside of each request to marginally improve performance
const router = new Router();
router.get('.*/api/player/minecraft/.*', minecraftLookup);
router.get('.*/api/player/steam/.*', steamLookup);
router.get('.*/api/player/xbox/.*', xboxLookup);

async function handleRequest(
	request: Request,
	env: Environment,
	ctx: ExecutionContext,
) {
	if (request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: {
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, OPTIONS',
				'Access-Control-Allow-Headers': '*',
				'Access-Control-Max-Age': '86400',
			},
		});
	}
	// hacky way to get a start time
	env.startTime = new Date();

	const url = new URL(request.url);

	// first try to get assets from KV, if not API
	let asset = null;
	try {
		if (!url.pathname.startsWith('/api')) {
			asset = await env.ASSETS.fetch(request);
		}
	} catch {
		// nothing to do. Fall through to API and 404 below
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
			for (const name of Object.keys(addHeaders)) {
				asset.headers.set(name, addHeaders[name as keyof typeof addHeaders]);
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

	// no KV asset, continue
	const cache = caches.default; // Cloudflare edge caching
	let type = 'unknown';
	if (url.pathname.includes('/player/minecraft')) {
		type = 'minecraft';
	} else if (url.pathname.includes('/player/steam')) {
		type = 'steam';
	} else if (url.pathname.includes('/player/xbox')) {
		type = 'xbox';
	}
	let response = await cache.match(url); // try to find match for this request in the edge cache
	if (process.env.NODE_ENV !== 'development' && response) {
		// use cache found on Cloudflare edge. Set X-Worker-Cache header for helpful debug
		const newHdrs = new Headers(response.headers);
		newHdrs.set('X-Worker-Cache', 'true');

		writeDataPoint(env, request, {
			cached: true,
			type,
		});
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: newHdrs,
		});
	}
	// get data using router
	let responseData: Record<string, unknown> = {};
	try {
		responseData = await router.route(request, env, ctx);
	} catch (err) {
		// handle errors in router. Ensure we create well-formed JSON responses
		console.error('ERROR', err);
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
		let status = 400;
		// @ts-expect-error errors aren't properly typed
		if (err?.statusCode && typeof err.statusCode === 'number') {
			// @ts-expect-error errors aren't properly typed
			status = err.statusCode;
		} else if (responseData.error) {
			status = 500;
		}
		// handle `api.404` code specifically as a 404 status
		// @ts-expect-error errors aren't properly typed
		if (err.code === 'api.404') {
			status = 404;
		}
		response = new Response(JSON.stringify(responseData), {
			status,
			headers: { ...apiHeader },
		});
		writeDataPoint(env, request, {
			type,
			// @ts-expect-error errors aren't properly typed
			error: err.code || 'unknown',
		});
	}

	if (request.method === 'OPTIONS' && responseData instanceof Response) {
		return responseData;
	}
	// actual responses (KV, etc.)
	if (responseData instanceof Response) {
		response = responseData;
	} else if (!response) {
		// not an error. Success, but json data from player lookup. Construct real response
		const responseFull = helpers.code('player.found', responseData) as Record<
			string,
			unknown
		>;
		responseFull.success = true;
		response = new Response(JSON.stringify(responseFull), {
			status: 200,
			headers: { ...apiHeader },
		});
	}
	// construct new response with mutable headers
	response = new Response(response.body, response);
	// set cache header on 200 response
	if (response.status === 200) {
		response.headers.set('Cache-Control', 'public, max-age=' + cacheTtl);
	} else {
		// only cache other things for 5 minutes (errors, 404s, etc.)
		response.headers.set('Cache-Control', 'public, max-age=300');
	}

	ctx.waitUntil(cache.put(url, response.clone())); // store current query in cache

	// if querying for username, store a cache for the ID of this player too
	try {
		const lookupQuery = url.pathname.split('/').pop() || '';
		// @ts-expect-error players aren't properly typed
		if (responseData?.player?.id && responseData?.player?.id !== lookupQuery) {
			const newUrl = new URL(url.toString());
			// @ts-expect-error players aren't properly typed
			newUrl.pathname = newUrl.pathname.slice(0, newUrl.pathname.length - lookupQuery.length) + responseData.player.id;
			ctx.waitUntil(cache.put(newUrl, response.clone())); // store in cache
		}
	} catch {
		// we tried to cache more. No problem if this doesn't work
	}

	return response;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		try {
			const result = await handleRequest(request, env, ctx);
			return result;
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
				headers: { ...apiHeader },
			});
		}
	},
} satisfies ExportedHandler<Environment>;
