const USER_CLEANUP_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const state = {
	/** @type {number} */
	startedAt: Date.now(),
	/** @type {number} */
	attempted: 0,
	/** @type {number} */
	succeeded: 0,
	/** @type {number} */
	failed: 0,
	/** @type {number} */
	tooLarge: 0,
	/** @type {Map<number, number>} */ /* userId → lastSeen */
	users: new Map(),
	/** @type {Record<string, number>} */
	byPlatform: {},
};

export const stats = {
	recordAttempt() { state.attempted++; },

	/**
	 * @param {string} platform
	 * @param {number} userId
	 */
	recordSuccess(platform, userId) {
		state.succeeded++;
		state.users.set(userId, Date.now());
		state.byPlatform[platform] = (state.byPlatform[platform] || 0) + 1;
	},

	recordFailure() { state.failed++; },

	recordTooLarge() { state.tooLarge++; state.failed++; },

	/**
	 * @param {number} userId
	 */
	recordUser(userId) { state.users.set(userId, Date.now()); },

	/** Remove stale users and zeroed platform counters. */
	cleanup() {
		const cutoff = Date.now() - USER_CLEANUP_MS;
		for (const [id, ts] of state.users) {
			if (ts < cutoff) state.users.delete(id);
		}
		for (const [platform, count] of Object.entries(state.byPlatform)) {
			if (count <= 0) delete state.byPlatform[platform];
		}
	},

	/** @returns {string} */
	summary() {
		const upSec = Math.floor((Date.now() - state.startedAt) / 1000);
		const h = Math.floor(upSec / 3600);
		const m = Math.floor((upSec % 3600) / 60);
		const s = upSec % 60;

		const top = Object.entries(state.byPlatform)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([p, n]) => `  • ${p}: ${n}`)
			.join("\n");

		return [
			"<b>Bot Statistics</b>\n",
			`Uptime: <b>${h}h ${m}m ${s}s</b>`,
			`Total Users: <b>${state.users.size}</b>`,
			`Attempted: <b>${state.attempted}</b>`,
			`Succeeded: <b>${state.succeeded}</b>`,
			`Failed: <b>${state.failed}</b>`,
			`Too large: <b>${state.tooLarge}</b>`,
			top ? `\n<b>Top platforms:</b>\n${top}` : "",
		]
			.filter(Boolean)
			.join("\n");
	},
};
