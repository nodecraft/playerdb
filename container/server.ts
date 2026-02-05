import http from 'node:http';
import https from 'node:https';

interface ProxyRequest {
	url: string;
	headers?: Record<string, string>;
}

const server = http.createServer((req, res) => {
	// Parse incoming request for proxy target
	// Expected: POST with JSON body containing { url, headers }

	if (req.method !== 'POST') {
		res.writeHead(405);
		res.end('Method not allowed');
		return;
	}

	let body = '';
	req.on('data', (chunk: Buffer) => {
		body += chunk;
	});
	req.on('end', () => {
		try {
			const parsed = JSON.parse(body) as ProxyRequest;

			// Validate required fields
			if (!parsed || typeof parsed !== 'object') {
				res.writeHead(400);
				res.end(JSON.stringify({ error: 'Request body must be a JSON object' }));
				return;
			}

			const { url, headers } = parsed;

			if (!url || typeof url !== 'string') {
				res.writeHead(400);
				res.end(JSON.stringify({ error: 'Missing or invalid "url" field' }));
				return;
			}

			if (headers !== undefined && (typeof headers !== 'object' || headers === null)) {
				res.writeHead(400);
				res.end(JSON.stringify({ error: 'Invalid "headers" field - must be an object' }));
				return;
			}

			// Validate URL format
			if (!URL.canParse(url)) {
				res.writeHead(400);
				res.end(JSON.stringify({ error: 'Invalid URL format' }));
				return;
			}
			const targetUrl = new URL(url);
			const options: https.RequestOptions = {
				hostname: targetUrl.hostname,
				port: 443,
				path: targetUrl.pathname + targetUrl.search,
				method: 'GET',
				headers: {
					...headers,
					'User-Agent': 'PlayerDB (+https://playerdb.co)',
				},
			};

			const proxyReq = https.request(options, (proxyRes) => {
				const status = proxyRes.statusCode ?? 500;
				if (status >= 500) {
					let responseBody = '';
					proxyRes.on('data', (chunk: Buffer) => {
						responseBody += chunk;
					});
					proxyRes.on('end', () => {
						console.error(`[Container] Upstream returned ${status} for ${targetUrl.pathname}:`, responseBody.slice(0, 500));
						res.writeHead(status, {
							'Content-Type': proxyRes.headers['content-type'] ?? 'application/json',
						});
						res.end(responseBody);
					});
					proxyRes.on('error', (err) => {
						console.error(`[Container] Error reading upstream ${status} body:`, err.message);
						if (!res.headersSent) {
							res.writeHead(502);
						}
						res.end();
					});
					return;
				}
				res.writeHead(status, {
					'Content-Type': proxyRes.headers['content-type'] ?? 'application/json',
				});
				proxyRes.pipe(res);
			});

			proxyReq.on('error', (err) => {
				res.writeHead(502);
				res.end(JSON.stringify({ error: 'Proxy request failed', message: err.message }));
			});

			proxyReq.setTimeout(10000, () => {
				proxyReq.destroy();
				res.writeHead(504);
				res.end(JSON.stringify({ error: 'Proxy request timeout' }));
			});

			proxyReq.end();
		} catch (err) {
			res.writeHead(400);
			res.end(JSON.stringify({ error: 'Invalid request', message: (err as Error).message }));
		}
	});
});

server.listen(8080, () => console.log('Proxy server running on port 8080'));
