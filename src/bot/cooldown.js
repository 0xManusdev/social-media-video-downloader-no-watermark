import { COOLDOWN_SECONDS } from "../config.js";

/** @type {Map<number, number>} userId → timestamp of the last accepted request */
const lastRequest = new Map();

/**
 * Seconds the user still has to wait, or 0 if the request is accepted (and stamped).
 * @param {number} userId
 * @returns {number}
 */
export function checkCooldown(userId) {
	const now = Date.now();
	const elapsed = (now - (lastRequest.get(userId) ?? 0)) / 1000;
	if (elapsed < COOLDOWN_SECONDS) return Math.ceil(COOLDOWN_SECONDS - elapsed);
	lastRequest.set(userId, now);
	return 0;
}

/** Forget users whose last request is long past the cooldown. */
export function sweepCooldowns() {
	const cutoff = Date.now() - COOLDOWN_SECONDS * 1000 * 10;
	for (const [id, ts] of lastRequest) if (ts < cutoff) lastRequest.delete(id);
}
