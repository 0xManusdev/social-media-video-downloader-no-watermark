import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";

// stats.js keeps its counters in module-level state, so each test gets a fresh instance
// via a cache-busting query instead of sharing one accumulating singleton.
const freshStats = async () => (await import(`../src/stats.js?case=${Math.random()}`)).stats;

test("recordAttempt/recordSuccess/recordFailure/recordTooLarge feed the summary counters", async () => {
	const stats = await freshStats();
	stats.recordAttempt();
	stats.recordAttempt();
	stats.recordSuccess("TikTok", 1);
	stats.recordFailure();
	stats.recordTooLarge();

	const summary = stats.summary();
	assert.match(summary, /Attempted: <b>2<\/b>/);
	assert.match(summary, /Succeeded: <b>1<\/b>/);
	assert.match(summary, /Failed: <b>2<\/b>/, "recordTooLarge also counts as a failure");
	assert.match(summary, /Too large: <b>1<\/b>/);
	assert.match(summary, /TikTok: 1/);
});

test("recordUser and recordSuccess both register a user, deduped by id", async () => {
	const stats = await freshStats();
	stats.recordUser(1);
	stats.recordUser(1);
	stats.recordSuccess("YouTube", 2);
	stats.recordUser(3);

	assert.match(stats.summary(), /Total Users: <b>3<\/b>/);
});

test("the top-platforms list is sorted by count, descending, and capped at 5", async () => {
	const stats = await freshStats();
	const counts = { A: 3, B: 5, C: 1, D: 4, E: 2, F: 9 };
	let userId = 0;
	for (const [platform, n] of Object.entries(counts)) {
		for (let i = 0; i < n; i++) stats.recordSuccess(platform, userId++);
	}

	const order = [...stats.summary().matchAll(/•\s+(\w+):/g)].map((m) => m[1]);
	assert.deepEqual(order, ["F", "B", "D", "A", "E"], "top 5 platforms by success count, C excluded");
});

test("cleanup() drops users last seen more than 7 days ago, keeps recent ones", async (t) => {
	t.mock.timers.enable({ apis: ["Date"] });
	const stats = await freshStats();

	stats.recordUser(1);
	t.mock.timers.tick(8 * 24 * 60 * 60 * 1000); // 8 days later
	stats.recordUser(2);

	stats.cleanup();
	assert.match(stats.summary(), /Total Users: <b>1<\/b>/, "only the stale user (1) should be dropped");
});
