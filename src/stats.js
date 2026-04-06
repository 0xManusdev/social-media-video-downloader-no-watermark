const state = {
  startedAt: Date.now(),
  attempted: 0,
  succeeded: 0,
  failed: 0,
  tooLarge: 0,
  users: new Set(),
  byPlatform: {},
};

export const stats = {
  recordAttempt() { state.attempted++; },
  recordSuccess(platform, userId) {
    state.succeeded++;
    state.users.add(userId);
    state.byPlatform[platform] = (state.byPlatform[platform] || 0) + 1;
  },
  recordFailure() { state.failed++; },
  recordTooLarge() { state.tooLarge++; state.failed++; },
  recordUser(userId) { state.users.add(userId); },

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
