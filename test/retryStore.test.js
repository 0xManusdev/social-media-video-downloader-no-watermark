import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";

const { saveForRetry, popForRetry, sweepRetryStore } = await import("../src/bot/retryStore.js");

test("popForRetry returns the URL once, then invalidates the id", () => {
	const id = saveForRetry("https://example.com/a", 42);
	assert.equal(popForRetry(id, 42), "https://example.com/a");
	assert.equal(popForRetry(id, 42), null, "a retry id can only be used once");
});

test("popForRetry refuses an id saved for a different user", () => {
	const id = saveForRetry("https://example.com/b", 1);
	assert.equal(popForRetry(id, 2), null, "another user's id must not resolve");
	assert.equal(popForRetry(id, 1), "https://example.com/b", "the rightful owner can still use it");
});

test("popForRetry returns null for an unknown id", () => {
	assert.equal(popForRetry("deadbeef", 1), null);
});

test("sweepRetryStore drops entries older than the TTL", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 10_000_000 });
	const id = saveForRetry("https://example.com/c", 7);

	t.mock.timers.tick(31 * 60 * 1000); // just past the 30-minute TTL
	sweepRetryStore();

	assert.equal(popForRetry(id, 7), null, "expired entries must be swept away");
});
