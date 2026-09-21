import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.COOLDOWN_SECONDS = "5";
const { checkCooldown, sweepCooldowns } = await import("../src/bot/cooldown.js");

// checkCooldown treats an unseen user as "last requested at epoch 0", which is only far
// enough in the past when the mocked clock itself starts well after 0 — otherwise a fake
// "now" near 0 makes even a first-ever request look like it's within the cooldown window.
const MOCK_NOW = 10_000_000;

test("checkCooldown accepts the first request, then blocks until COOLDOWN_SECONDS pass", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: MOCK_NOW });

	assert.equal(checkCooldown(1), 0, "first request for a user is accepted immediately");

	t.mock.timers.tick(2000);
	const wait = checkCooldown(1);
	assert.ok(wait > 0 && wait <= 3, `expected ~3s left, got ${wait}`);

	t.mock.timers.tick(3000);
	assert.equal(checkCooldown(1), 0, "accepted again once the full cooldown has elapsed");
});

test("checkCooldown tracks each user independently", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: MOCK_NOW });

	assert.equal(checkCooldown(100), 0);
	assert.ok(checkCooldown(100) > 0, "user 100 is now on cooldown");
	assert.equal(checkCooldown(200), 0, "a different user is unaffected by user 100's cooldown");
});

test("sweepCooldowns does not prematurely clear a user still within the cooldown window", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: MOCK_NOW });

	checkCooldown(555);
	t.mock.timers.tick(1000); // well short of the 10x COOLDOWN_SECONDS sweep cutoff
	sweepCooldowns();

	assert.ok(checkCooldown(555) > 0, "user 555 must still be on cooldown after an early sweep");
});
