import { MAX_CONCURRENT } from "./config.js";

/** Async semaphore — limits concurrent downloads */
class Semaphore {
  #count;
  #queue = [];

  constructor(n) { this.#count = n; }

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
  get active() { return MAX_CONCURRENT - this.#count; }
}

const global = new Semaphore(MAX_CONCURRENT);
const perUser = new Map();

function userSem(userId) {
  if (!perUser.has(userId)) perUser.set(userId, new Semaphore(1));
  return perUser.get(userId);
}

export const queue = {
  async acquire(userId) {
    await userSem(userId).acquire();
    await global.acquire();
  },
  release(userId) {
    userSem(userId).release();
    global.release();
  },
  activeDownloads() { return global.active; },
  queueDepth() { return global.waiting; },
};
