import { tracing } from 'cloudflare:workers';
import {
	afterEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';

import { helpers as minecraftHelpers } from '../src/libs/minecraft';

// Spans record no telemetry locally (`isTraced` is false) but the API still
// runs, so these tests pin the contract src/libs/minecraft.ts relies on.
describe('custom tracing spans', () => {
	it('passes through sync return values', () => {
		const result = tracing.enterSpan('test.sync', () => 'ok');
		expect(result).toBe('ok');
	});

	it('passes through async return values', async () => {
		const result = await tracing.enterSpan('test.async', async () => 'ok');
		expect(result).toBe('ok');
	});

	it('propagates exceptions', () => {
		expect(() => tracing.enterSpan('test.throw', () => {
			throw new Error('boom');
		})).toThrow('boom');
	});

	it('propagates async rejections', async () => {
		await expect(tracing.enterSpan('test.reject', async () => {
			throw new Error('boom');
		})).rejects.toThrow('boom');
	});

	it('supports nested spans', () => {
		const result = tracing.enterSpan('test.outer', () => tracing.enterSpan('test.inner', () => 'nested'));
		expect(result).toBe('nested');
	});

	it('accepts all attribute value types, including undefined', () => {
		tracing.enterSpan('test.attributes', (span) => {
			expect(typeof span.isTraced).toBe('boolean');
			expect(() => {
				span.setAttribute('string', 'value');
				span.setAttribute('number', 42);
				span.setAttribute('boolean', true);
				span.setAttribute('undefined', undefined);
			}).not.toThrow();
		});
	});
});

// bound before any spy is installed
const originalEnterSpan = tracing.enterSpan.bind(tracing);

interface RecordedSpan {
	name: string;
	attributes: Record<string, string | number | boolean | undefined>;
}

// Records each span's name and `setAttribute` calls while delegating to the
// real runtime API.
function captureSpans(): RecordedSpan[] {
	const recorded: RecordedSpan[] = [];
	vi.spyOn(tracing, 'enterSpan').mockImplementation((name, callback, ...args) => originalEnterSpan(name, (span, ...callbackArgs) => {
		const record: RecordedSpan = { name, attributes: {} };
		recorded.push(record);
		const recordingSpan: Pick<typeof span, 'isTraced' | 'setAttribute'> = {
			get isTraced() {
				return span.isTraced;
			},
			setAttribute(key, value) {
				record.attributes[key] = value;
				span.setAttribute(key, value);
			},
		};
		return callback(recordingSpan as typeof span, ...callbackArgs);
	}, ...args));
	return recorded;
}

describe('minecraft tcpRequest tracing', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('records spans and attributes for a successful request', async () => {
		const spans = captureSpans();
		const body = await minecraftHelpers.tcpRequest({
			host: 'https://sessionserver.mojang.com/',
			path: 'session/minecraft/profile/ef6134805b6244e4a4467fbe85d65513?unsigned=false',
		});
		expect(body.request_type).toBe('tcp');

		expect(spans.map(span => span.name)).toEqual(['mojang.tcpRequest', 'tcp.connect', 'tcp.read']);
		const [mainSpan, connectSpan, readSpan] = spans;

		expect(mainSpan.attributes).toMatchObject({
			'http.request.method': 'GET',
			'url.full': 'https://sessionserver.mojang.com/session/minecraft/profile/ef6134805b6244e4a4467fbe85d65513?unsigned=false',
			'url.scheme': 'https',
			'server.address': 'sessionserver.mojang.com',
			'server.port': 443,
			'network.transport': 'tcp',
			'network.protocol.name': 'http',
			'network.protocol.version': '1.1',
			'http.response.status_code': 200,
		});
		expect(mainSpan.attributes['http.request.size']).toBeGreaterThan(0);
		expect(mainSpan.attributes['http.response.body.size']).toBeGreaterThan(0);
		expect(typeof mainSpan.attributes['network.peer.address']).toBe('string');
		expect(mainSpan.attributes['error.type']).toBeUndefined();

		// connect span is timing-only
		expect(connectSpan.attributes).toEqual({});
		// wire bytes include status line + headers, so always exceed the body
		expect(readSpan.attributes['http.response.size']).toBeGreaterThan(mainSpan.attributes['http.response.body.size'] as number);
	});

	it('records error.type when the socket cannot connect', async () => {
		const spans = captureSpans();
		await expect(minecraftHelpers.tcpRequest({
			// .invalid never resolves (RFC 2606)
			host: 'https://playerdb-tracing-test.invalid/',
			path: 'unused',
		})).rejects.toMatchObject({ code: 'minecraft.api_failure' });

		expect(spans.map(span => span.name)).toEqual(['mojang.tcpRequest', 'tcp.connect']);
		const mainSpan = spans[0];
		expect(typeof mainSpan.attributes['error.type']).toBe('string');
		expect(mainSpan.attributes['http.response.status_code']).toBeUndefined();
	});

	it('records the status code as error.type for non-200 responses', async () => {
		const spans = captureSpans();
		await expect(minecraftHelpers.tcpRequest({
			host: 'https://api.minecraftservices.com/',
			path: 'minecraft/profile/lookup/name/cherryjimbo-nope',
		})).rejects.toMatchObject({ code: 'minecraft.invalid_username' });

		const mainSpan = spans.find(span => span.name === 'mojang.tcpRequest');
		const statusCode = mainSpan?.attributes['http.response.status_code'];
		expect(statusCode).not.toBe(200);
		expect(mainSpan?.attributes['error.type']).toBe(String(statusCode));
	});

	it('classifies a bodyless 204 profile response as an invalid username', async () => {
		const spans = captureSpans();
		await expect(minecraftHelpers.tcpRequest({
			host: 'https://sessionserver.mojang.com/',
			path: 'session/minecraft/profile/00000000000000000000000000000000?unsigned=false',
		})).rejects.toMatchObject({ code: 'minecraft.invalid_username' });

		const mainSpan = spans.find(span => span.name === 'mojang.tcpRequest');
		expect(mainSpan?.attributes['http.response.status_code']).toBe(204);
		expect(mainSpan?.attributes['error.type']).toBe('204');
	});
});
