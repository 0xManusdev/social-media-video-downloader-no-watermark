import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";

import { BOT_TOKEN } from "./config.js";
import { registerCommands, BOT_COMMANDS } from "./bot/commands.js";
import { handleTextMessage, handleRetryAction, RETRY_ACTION_PATTERN } from "./bot/downloadHandler.js";
import { sweepCooldowns } from "./bot/cooldown.js";
import { sweepRetryStore } from "./bot/retryStore.js";
import { warmUp } from "./media/ytdlp.js";
import { COOLDOWN_SECONDS } from "./config.js";
import { queue } from "./queue.js";
import { stats } from "./stats.js";

const bot = new Telegraf(BOT_TOKEN, {
	telegram: { apiRoot: "https://api.telegram.org" },
	handlerTimeout: 300_000,
});

registerCommands(bot);
bot.on(message("text"), handleTextMessage);
bot.action(RETRY_ACTION_PATTERN, handleRetryAction);

bot.catch((err) => {
	console.error("Unhandled bot error:", err.message);
});

warmUp()
	.then(({ command, canImpersonate }) =>
		console.log(`yt-dlp: ${command} (browser impersonation: ${canImpersonate ? "yes" : "NO"})`)
	)
	.catch((err) => console.warn(err.message));

try {
	await bot.telegram.setMyCommands(BOT_COMMANDS);
} catch (err) {
	if (err.response?.error_code === 429) {
		const retryAfter = err.response.parameters?.retry_after ?? "unknown";
		console.warn(`setMyCommands rate limited — retry after ${retryAfter}s. Commands unchanged.`);
	} else {
		console.warn("setMyCommands failed:", err.message);
	}
}

const SHUTDOWN_DRAIN_TIMEOUT_MS = 25_000;

/** Poll until no downloads are active, or the timeout elapses. */
function waitForActiveDownloads(timeoutMs) {
	return new Promise((resolve) => {
		const deadline = Date.now() + timeoutMs;
		const check = () => {
			if (queue.activeDownloads() === 0 || Date.now() >= deadline) return resolve();
			setTimeout(check, 500);
		};
		check();
	});
}

async function shutdown(signal) {
	console.log(`Received ${signal}, shutting down...`);
	// Stop accepting new updates first so activeDownloads() can only drain, not grow.
	try { await bot.stop(signal); } catch {}

	const active = queue.activeDownloads();
	if (active > 0) {
		console.log(`Waiting up to ${SHUTDOWN_DRAIN_TIMEOUT_MS / 1000}s for ${active} active download(s) to finish...`);
		await waitForActiveDownloads(SHUTDOWN_DRAIN_TIMEOUT_MS);
		if (queue.activeDownloads() > 0) console.warn(`Exiting with ${queue.activeDownloads()} download(s) still in flight.`);
	}
	process.exit(0);
}

bot.launch({ dropPendingUpdates: true });
console.log("Bot is running...");

setInterval(sweepCooldowns, Math.max(COOLDOWN_SECONDS * 60_000, 60_000)).unref();
setInterval(sweepRetryStore, 600_000).unref();
setInterval(() => queue.cleanupIdleUsers(), 600_000).unref();
setInterval(() => stats.cleanup(), 3_600_000).unref();

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
