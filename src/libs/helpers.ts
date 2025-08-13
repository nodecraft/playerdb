import codes from '../error_codes/codes';

const code = function(
	code: keyof typeof codes,
	data: Record<string, unknown> = {},
) {
	if (!codes[code]) {
		throw new Error('No return code found with code: ' + code);
	}
	// code & message, merged with data
	return { code: code, message: codes[code], data };
};

type ErrorData = {
	message?: string;
	statusCode?: number;
	[key: string]: unknown;
};
class failCode extends Error {
	// eslint-disable-line unicorn/custom-error-definition
	code: string;
	data: Record<string, unknown>;
	statusCode?: number;
	constructor(codeStr: keyof typeof codes, data: ErrorData = {}) {
		const codeData = code(codeStr, data);
		super(codeData.message ?? codeStr);
		this.name = 'failCode';
		this.code = codeData.code;
		this.data = codeData.data;
		if (data?.message) {
			this.message = data.message;
			delete this.data.message;
		}
		if (data?.statusCode) {
			this.statusCode = data.statusCode;
			delete this.data.statusCode;
		}
	}
}

class errorCode extends Error {
	// eslint-disable-line unicorn/custom-error-definition
	code: string;
	data: Record<string, unknown>;
	statusCode?: number;
	constructor(codeStr: keyof typeof codes, data: ErrorData = {}) {
		const codeData = code(codeStr, data);
		super(codeData.message ?? codeStr);
		this.name = 'errorCode';
		this.code = codeData.code;
		this.data = codeData.data;
		if (data?.message) {
			this.message = data.message;
			delete this.data.message;
		}
		if (data?.statusCode) {
			this.statusCode = data.statusCode;
			delete this.data.statusCode;
		}
	}
}

export { code, failCode, errorCode };
