/**
 * Decode chunked transfer encoding
 * Format: <hex-size>\r\n<data>\r\n... repeated, ending with 0\r\n\r\n
 * Optional trailers may appear after the final chunk before the terminating CRLF
 */
export function decodeChunked(data: string): string {
	const chunks: string[] = [];
	let position = 0;
	let properlyTerminated = false;

	while (position < data.length) {
		// Find chunk size line (hex number followed by CRLF)
		const sizeEnd = data.indexOf('\r\n', position);
		if (sizeEnd === -1) {
			throw new Error('Invalid chunked encoding: missing chunk size terminator');
		}

		// Chunk size may have optional chunk extensions after semicolon (ignore them)
		const sizeLine = data.slice(position, sizeEnd);
		const sizeHex = sizeLine.split(';')[0].trim();
		const chunkSize = Number.parseInt(sizeHex, 16);

		if (Number.isNaN(chunkSize)) {
			throw new TypeError(`Invalid chunk size: ${sizeHex}`);
		}

		// Size 0 = final chunk
		if (chunkSize === 0) {
			properlyTerminated = true;
			// Skip any optional trailers (headers after final chunk)
			// Trailers end with CRLF, and the message ends with another CRLF
			// We don't need to parse them, just acknowledge proper termination
			break;
		}

		// Extract chunk data
		const chunkStart = sizeEnd + 2; // skip \r\n
		const chunkEnd = chunkStart + chunkSize;

		if (chunkEnd > data.length) {
			throw new Error('Chunk extends beyond available data');
		}

		chunks.push(data.slice(chunkStart, chunkEnd));

		// Move past chunk data and trailing \r\n
		position = chunkEnd + 2;
	}

	if (!properlyTerminated) {
		throw new Error('Invalid chunked encoding: missing final chunk');
	}

	return chunks.join('');
}

export function parseResponse(data: string) {
	// Split into (head, body)
	const splitIndex = data.indexOf('\r\n\r\n');
	if (splitIndex === -1) {
		throw new Error('Data does not contain CRLFCRLF');
	}
	const headData = data.slice(0, splitIndex);
	const rawBodyData = data.slice(splitIndex + 4);
	const headLines = headData.split('\r\n');

	// First line
	const firstLine = headLines[0];
	const match = firstLine.match(/^HTTP\/1\.[01] (\d{3}) (.*)$/);
	if (!match) {
		throw new Error('Invalid status line');
	}
	const statusCode = Number.parseInt(match[1], 10);
	const statusMessage = match[2];

	// Headers
	const headers: Record<string, string> = {};
	for (let idx = 1; idx < headLines.length; idx++) {
		const line = headLines[idx];
		// Per RFC 7230, the space after colon is optional (OWS = optional whitespace)
		const i = line.indexOf(':');
		if (i === -1) {
			throw new Error('Header line does not contain ":"');
		}
		const key = line.slice(0, i).toLowerCase();
		// Trim leading whitespace from value (handles both ": value" and ":value")
		const val = line.slice(i + 1).trimStart();
		headers[key] = val;
	}

	let bodyData;

	const transferEncoding = headers['transfer-encoding'];
	const contentLengthText = headers['content-length'];

	if (transferEncoding?.toLowerCase() === 'chunked') {
		// Decode chunked transfer encoding
		bodyData = decodeChunked(rawBodyData);
	} else if (contentLengthText) {
		if (!/^\d+$/.test(contentLengthText)) {
			throw new Error('Content-Length is not a valid non-negative integer');
		}
		const contentLength = Number.parseInt(contentLengthText, 10);
		// Content-Length is in bytes, not characters. Use TextEncoder to get byte length
		// since multi-byte UTF-8 characters would cause .length to differ from byte count.
		const bodyByteLength = new TextEncoder().encode(rawBodyData).length;
		if (contentLength !== bodyByteLength) {
			throw new Error(
				'Content-Length does not match the length of the body data we have',
			);
		}
		bodyData = rawBodyData;
	} else {
		throw new Error('Unable to determine body length (no Content-Length or Transfer-Encoding: chunked)');
	}

	return { statusCode, statusMessage, headers, bodyData };
}
