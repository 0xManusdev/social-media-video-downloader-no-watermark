export class DownloadError extends Error {
	/**
	 * @param {string} message
	 * @param {{ code?: string, authError?: boolean }} [opts]
	 */
	constructor(message, { code, authError } = {}) {
		super(message);
		this.name = "DownloadError";
		this.code = code;
		this.authError = Boolean(authError);
	}
}

export class FileTooLargeError extends Error {
	constructor(message) {
		super(message);
		this.name = "FileTooLargeError";
	}
}
