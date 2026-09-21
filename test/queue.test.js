import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.MAX_CONCURRENT_DOWNLOADS = "2";
const { queue } = await import("../src/queue.js");

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("the global semaphore caps concurrent downloads and queues the rest", async () => {
	await queue.acquire(1);
	await queue.acquire(2);
	assert.equal(queue.activeDownloads(), 2);

	let thirdAcquired = false;
	const third = queue.acquire(3).then(() => { thirdAcquired = true; });
	await tick();
	assert.equal(thirdAcquired, false, "a third concurrent user should wait for a free slot");
	assert.equal(queue.queueDepth(), 1);

	queue.release(1);
	await third;
	assert.equal(thirdAcquired, true);
	assert.equal(queue.activeDownloads(), 2);

	queue.release(2);
	queue.release(3);
	assert.equal(queue.activeDownloads(), 0);
});

test("a user's own downloads are serialized even when the global pool has room", async () => {
	await queue.acquire(10);
	let secondAcquired = false;
	const second = queue.acquire(10).then(() => { secondAcquired = true; });
	await tick();
	assert.equal(secondAcquired, false, "the same user's second request must wait for the first to release");

	queue.release(10);
	await second;
	assert.equal(secondAcquired, true);
	queue.release(10);
});

test("cleanupIdleUsers is safe to call and does not disturb an active user's slot", async () => {
	await queue.acquire(20);
	queue.cleanupIdleUsers();
	assert.equal(queue.activeDownloads(), 1, "user 20's active download must survive a cleanup sweep");
	queue.release(20);

	queue.cleanupIdleUsers();
	await queue.acquire(20);
	assert.equal(queue.activeDownloads(), 1, "the user can acquire again after being swept out while idle");
	queue.release(20);
});
