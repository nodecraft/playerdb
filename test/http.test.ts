import { describe, expect, it } from 'vitest';

import { decodeChunked, parseResponse } from '../src/libs/http';

describe('decodeChunked', () => {
	it('decodes a single chunk', () => {
		const chunked = '5\r\nhello\r\n0\r\n\r\n';
		expect(decodeChunked(chunked)).toBe('hello');
	});

	it('decodes multiple chunks', () => {
		const chunked = '5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n';
		expect(decodeChunked(chunked)).toBe('hello world');
	});

	it('decodes chunks with uppercase hex', () => {
		const chunked = 'A\r\n0123456789\r\n0\r\n\r\n';
		expect(decodeChunked(chunked)).toBe('0123456789');
	});

	it('decodes chunks with lowercase hex', () => {
		const chunked = 'a\r\n0123456789\r\n0\r\n\r\n';
		expect(decodeChunked(chunked)).toBe('0123456789');
	});

	it('handles chunk extensions (ignored)', () => {
		const chunked = '5;ext=value\r\nhello\r\n0\r\n\r\n';
		expect(decodeChunked(chunked)).toBe('hello');
	});

	it('handles empty body (zero chunk only)', () => {
		const chunked = '0\r\n\r\n';
		expect(decodeChunked(chunked)).toBe('');
	});

	it('decodes JSON payload', () => {
		const json = '{"name":"test","id":"123"}';
		const chunked = `${json.length.toString(16)}\r\n${json}\r\n0\r\n\r\n`;
		expect(decodeChunked(chunked)).toBe(json);
	});

	it('throws on missing chunk size terminator', () => {
		const chunked = '5hello';
		expect(() => decodeChunked(chunked)).toThrow('missing chunk size terminator');
	});

	it('throws on invalid chunk size', () => {
		const chunked = 'xyz\r\nhello\r\n0\r\n\r\n';
		expect(() => decodeChunked(chunked)).toThrow('Invalid chunk size');
	});

	it('throws when chunk extends beyond data', () => {
		const chunked = 'ff\r\nhello\r\n0\r\n\r\n'; // claims 255 bytes but only 5
		expect(() => decodeChunked(chunked)).toThrow('Chunk extends beyond available data');
	});

	it('throws on missing final chunk terminator', () => {
		const chunked = '5\r\nhello\r\n'; // missing 0\r\n\r\n
		expect(() => decodeChunked(chunked)).toThrow('missing final chunk');
	});
});

describe('parseResponse', () => {
	it('parses response with Content-Length', () => {
		const response = [
			'HTTP/1.1 200 OK',
			'Content-Type: application/json',
			'Content-Length: 13',
			'',
			'{"test":true}',
		].join('\r\n');

		const parsed = parseResponse(response);
		expect(parsed.statusCode).toBe(200);
		expect(parsed.statusMessage).toBe('OK');
		expect(parsed.headers['content-type']).toBe('application/json');
		expect(parsed.headers['content-length']).toBe('13');
		expect(parsed.bodyData).toBe('{"test":true}');
	});

	it('parses response with chunked transfer encoding', () => {
		const response = [
			'HTTP/1.1 200 OK',
			'Content-Type: application/json',
			'Transfer-Encoding: chunked',
			'',
			'd\r\n{"test":true}\r\n0\r\n\r\n',
		].join('\r\n');

		const parsed = parseResponse(response);
		expect(parsed.statusCode).toBe(200);
		expect(parsed.statusMessage).toBe('OK');
		expect(parsed.headers['transfer-encoding']).toBe('chunked');
		expect(parsed.bodyData).toBe('{"test":true}');
	});

	it('parses HTTP/1.0 response', () => {
		const response = [
			'HTTP/1.0 200 OK',
			'Content-Length: 4',
			'',
			'test',
		].join('\r\n');

		const parsed = parseResponse(response);
		expect(parsed.statusCode).toBe(200);
	});

	it('parses 404 response', () => {
		const response = [
			'HTTP/1.1 404 Not Found',
			'Content-Length: 9',
			'',
			'not found',
		].join('\r\n');

		const parsed = parseResponse(response);
		expect(parsed.statusCode).toBe(404);
		expect(parsed.statusMessage).toBe('Not Found');
	});

	it('parses 204 No Content with zero Content-Length', () => {
		const response = [
			'HTTP/1.1 204 No Content',
			'Content-Length: 0',
			'',
			'',
		].join('\r\n');

		const parsed = parseResponse(response);
		expect(parsed.statusCode).toBe(204);
		expect(parsed.bodyData).toBe('');
	});

	it('handles case-insensitive Transfer-Encoding header', () => {
		const response = [
			'HTTP/1.1 200 OK',
			'transfer-encoding: CHUNKED',
			'',
			'4\r\ntest\r\n0\r\n\r\n',
		].join('\r\n');

		const parsed = parseResponse(response);
		expect(parsed.bodyData).toBe('test');
	});

	it('handles headers without space after colon', () => {
		const response = [
			'HTTP/1.1 200 OK',
			'Content-Type:application/json',
			'Content-Length:13',
			'',
			'{"test":true}',
		].join('\r\n');

		const parsed = parseResponse(response);
		expect(parsed.headers['content-type']).toBe('application/json');
		expect(parsed.headers['content-length']).toBe('13');
		expect(parsed.bodyData).toBe('{"test":true}');
	});

	it('throws on missing CRLFCRLF', () => {
		const response = 'HTTP/1.1 200 OK\r\nContent-Length: 0';
		expect(() => parseResponse(response)).toThrow('Data does not contain CRLFCRLF');
	});

	it('throws on invalid status line', () => {
		const response = 'INVALID\r\n\r\n';
		expect(() => parseResponse(response)).toThrow('Invalid status line');
	});

	it('throws on missing body length indicator', () => {
		const response = [
			'HTTP/1.1 200 OK',
			'Content-Type: application/json',
			'',
			'{"test":true}',
		].join('\r\n');

		expect(() => parseResponse(response)).toThrow('Unable to determine body length');
	});

	it('throws on Content-Length mismatch', () => {
		const response = [
			'HTTP/1.1 200 OK',
			'Content-Length: 100',
			'',
			'short',
		].join('\r\n');

		expect(() => parseResponse(response)).toThrow('Content-Length does not match');
	});

	it('throws on invalid Content-Length', () => {
		const response = [
			'HTTP/1.1 200 OK',
			'Content-Length: abc',
			'',
			'test',
		].join('\r\n');

		expect(() => parseResponse(response)).toThrow('Content-Length is not a valid');
	});

	it('throws on header line without colon', () => {
		const response = [
			'HTTP/1.1 200 OK',
			'InvalidHeader',
			'',
			'',
		].join('\r\n');

		expect(() => parseResponse(response)).toThrow('Header line does not contain ":"');
	});

	it('correctly validates Content-Length with multi-byte UTF-8 characters', () => {
		// "café" is 5 bytes in UTF-8 (c=1, a=1, f=1, é=2)
		const body = 'café';
		const byteLength = new TextEncoder().encode(body).length; // 5
		expect(byteLength).toBe(5); // Sanity check

		const response = [
			'HTTP/1.1 200 OK',
			`Content-Length: ${byteLength}`,
			'',
			body,
		].join('\r\n');

		const parsed = parseResponse(response);
		expect(parsed.statusCode).toBe(200);
		expect(parsed.bodyData).toBe('café');
	});

	it('correctly validates Content-Length with emoji (4-byte UTF-8)', () => {
		// "hi 👋" has emoji which is 4 bytes in UTF-8
		const body = 'hi 👋';
		const byteLength = new TextEncoder().encode(body).length; // 7 (h=1, i=1, space=1, 👋=4)
		expect(byteLength).toBe(7); // Sanity check

		const response = [
			'HTTP/1.1 200 OK',
			`Content-Length: ${byteLength}`,
			'',
			body,
		].join('\r\n');

		const parsed = parseResponse(response);
		expect(parsed.statusCode).toBe(200);
		expect(parsed.bodyData).toBe('hi 👋');
	});

	it('correctly validates Content-Length with Chinese characters', () => {
		// Chinese characters are 3 bytes each in UTF-8
		const body = '你好';
		const byteLength = new TextEncoder().encode(body).length; // 6
		expect(byteLength).toBe(6); // Sanity check

		const response = [
			'HTTP/1.1 200 OK',
			`Content-Length: ${byteLength}`,
			'',
			body,
		].join('\r\n');

		const parsed = parseResponse(response);
		expect(parsed.statusCode).toBe(200);
		expect(parsed.bodyData).toBe('你好');
	});

	it('throws on Content-Length mismatch with multi-byte characters', () => {
		// "café" is 5 bytes but 4 characters
		const body = 'café';
		const charLength = body.length; // 4 (incorrect)

		const response = [
			'HTTP/1.1 200 OK',
			`Content-Length: ${charLength}`, // Using char length instead of byte length
			'',
			body,
		].join('\r\n');

		expect(() => parseResponse(response)).toThrow('Content-Length does not match');
	});
});
