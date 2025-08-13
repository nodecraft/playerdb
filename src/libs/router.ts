/*
BASED ON https://github.com/cloudflare/worker-template-router
LICENSE: ISC
 */

import { failCode } from './helpers';

import type { Environment } from '../types';

type Condition = (req: Request) => boolean;
type Handler = (
	req: Request,
	env: Environment,
	ctx: ExecutionContext
) => NonNullable<unknown>;

type Route = {
	conditions: Condition[] | Condition;
	handler: Handler;
};

const Method =
	(method: string) => (req: Request): boolean => req.method.toLowerCase() === method.toLowerCase();
const Connect = Method('connect');
const Delete = Method('delete');
const Get = Method('get');
const Head = Method('head');
const Options = Method('options');
const Patch = Method('patch');
const Post = Method('post');
const Put = Method('put');
const Trace = Method('trace');

const Header =
	(header: string, val: string) => (req: Request): boolean => req.headers.get(header) === val;
const Host = (host: string) => Header('host', host.toLowerCase()); // eslint-disable-line no-unused-vars
const Referrer = (host: string) => Header('referrer', host.toLowerCase()); // eslint-disable-line no-unused-vars

const Path =
	(regExp: RegExp | string) => (req: Request): boolean => {
		const url = new URL(req.url);
		const path = url.pathname;
		const match = path.match(regExp) || [];
		return match[0] === path;
	};

class Router {
	routes: Route[];

	constructor() {
		this.routes = [];
	}

	handle(conditions: Condition[] | Condition, handler: Handler): this {
		this.routes.push({
			conditions,
			handler,
		});
		return this;
	}

	connect(url: RegExp | string, handler: Handler): this {
		return this.handle([Connect, Path(url)], handler);
	}

	delete(url: RegExp | string, handler: Handler): this {
		return this.handle([Delete, Path(url)], handler);
	}

	get(url: RegExp | string, handler: Handler): this {
		return this.handle([Get, Path(url)], handler);
	}

	head(url: RegExp | string, handler: Handler): this {
		return this.handle([Head, Path(url)], handler);
	}

	options(url: RegExp | string, handler: Handler): this {
		return this.handle([Options, Path(url)], handler);
	}

	patch(url: RegExp | string, handler: Handler): this {
		return this.handle([Patch, Path(url)], handler);
	}

	post(url: RegExp | string, handler: Handler): this {
		return this.handle([Post, Path(url)], handler);
	}

	put(url: RegExp | string, handler: Handler): this {
		return this.handle([Put, Path(url)], handler);
	}

	trace(url: RegExp | string, handler: Handler): this {
		return this.handle([Trace, Path(url)], handler);
	}

	all(handler: Handler): this {
		return this.handle([], handler);
	}

	route(req: Request, env: Environment, ctx: ExecutionContext) {
		const route = this.resolve(req);

		if (route) {
			return route.handler(req, env, ctx);
		}
		throw new failCode('api.404');
	}

	/**
	 * resolve returns the matching route for a request that returns
	 * true for all conditions (if any).
	 */
	resolve(req: Request) {
		return this.routes.find((route) => {
			if (
				!route.conditions ||
				(Array.isArray(route) && route.conditions.length === 0)
			) {
				return true;
			}

			if (typeof route.conditions === 'function') {
				return route.conditions(req);
			}

			return route.conditions.every(condition => condition(req));
		});
	}
}

export default Router;
