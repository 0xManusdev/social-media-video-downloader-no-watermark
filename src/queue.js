import { MAX_CONCURRENT } from "./config.js";

class Semaphore {
	/** @type {number} */
	#capacity;
	/** @type {number} */
	#count;
	/** @type {(() => void)[]} */
	#queue = [];

	constructor(n) {
		this.#capacity = n;
		this.#count = n;
	}

	acquire() {
		if (this.#count > 0) {
			this.#count--;
			return Promise.resolve();
		}
		return new Promise((resolve) => this.#queue.push(resolve));
	}

	release() {
		if (this.#queue.length > 0) {
			this.#queue.shift()();
		} else {
			this.#count++;
		}
	}

	get waiting() { return this.#queue.length; }
	get active() { return Math.max(0, this.#capacity - this.#count); }
	get idle() { return this.#count === this.#capacity && this.#queue.length === 0; }
}

/** @type {Semaphore} */
const global = new Semaphore(MAX_CONCURRENT);
/** @type {Map<number, Semaphore>} */
const perUser = new Map();

function userSem(userId) {
	if (!perUser.has(userId)) perUser.set(userId, new Semaphore(1));
	return perUser.get(userId);
}

export const queue = {
	/**
	 * Acquire both per-user and global download slot.
	 * @param {number} userId
	 */
	async acquire(userId) {
		await userSem(userId).acquire();
		await global.acquire();
	},

	/**
	 * Release both per-user and global download slot.
	 * @param {number} userId
	 */
	release(userId) {
		userSem(userId).release();
		global.release();
	},

	/** Remove semaphores for users with no active/pending downloads. */
	cleanupIdleUsers() {
		for (const [id, sem] of perUser) {
			if (sem.idle) perUser.delete(id);
		}
	},

	/** @returns {number} */
	activeDownloads() { return global.active; },
	/** @returns {number} */
	queueDepth() { return global.waiting; },
};
