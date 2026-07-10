import { createReadStream } from "fs";
import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";

import { BOT_TOKEN, ADMIN_IDS, COOLDOWN_SECONDS, PLATFORMS } from "./config.js";
import { extractUrls, identifyPlatform, formatBytes, escapeHtml, isInstagramGallery } from "./utils.js";
import { download, cleanup, downloadImages, cleanupImages, DownloadError, FileTooLargeError } from "./downloader.js";
import { stats } from "./stats.js";
import { queue } from "./queue.js";

const bot = new Telegraf(BOT_TOKEN, {
	telegram: { apiRoot: "https://api.telegram.org" },
	handlerTimeout: 300_000,
});

const lastRequest = new Map();

function checkCooldown(userId) {
	const now = Date.now();
	const elapsed = (now - (lastRequest.get(userId) ?? 0)) / 1000;
	if (elapsed < COOLDOWN_SECONDS) return Math.ceil(COOLDOWN_SECONDS - elapsed);
	lastRequest.set(userId, now);
	return 0;
}

setInterval(
	() => {
		const cutoff = Date.now() - COOLDOWN_SECONDS * 1000 * 10; // 10x cooldown
		for (const [id, ts] of lastRequest) if (ts < cutoff) lastRequest.delete(id);
	},
	Math.max(COOLDOWN_SECONDS * 60_000, 60_000)
).unref();

async function editStatus(ctx, msgId, text, extra = {}) {
	try {
		await ctx.telegram.editMessageText(ctx.chat.id, msgId, undefined, text, extra);
	} catch (err) {
		const msg = err.message || "";
		const ignore = ["not modified", "message to edit not found", "message can't be edited"];
		if (!ignore.some((s) => msg.includes(s))) throw err;
	}
}

bot.start((ctx) => {
	stats.recordUser(ctx.from.id);
	return ctx.replyWithHTML(
		`<b>Welcome to the Video Downloader Bot!</b>\n\n` +
		`I download the best quality video from:\n` +
		`<i>${Object.keys(PLATFORMS).join(", ")}</i>\n\n` +
		`Just send me a link!`
	);
});

bot.help((ctx) =>
	ctx.replyWithHTML(
		[
			"<b>How to use</b>\n",
			"Paste a video link — the bot downloads and sends it automatically.\n",
			"<b>Supported Platforms:</b>",
			...Object.keys(PLATFORMS).sort().map((p) => `• ${p}`),
			"\n<b>Commands:</b>",
			"/id — Your Telegram user ID",
			"/status — Queue status",
			"/stats — Statistics (admin)",
		].join("\n")
	)
);

bot.command("id", (ctx) => ctx.reply(`Your Telegram ID is: ${ctx.from.id}`));

bot.command("status", (ctx) =>
	ctx.replyWithHTML(
		`<b>Bot Status</b>\n\n` +
		`Active downloads: <b>${queue.activeDownloads()}</b>\n` +
		`Waiting in queue: <b>${queue.queueDepth()}</b>`
	)
);

bot.command("stats", (ctx) => {
	if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply("Admin only.");
	return ctx.replyWithHTML(stats.summary());
});

bot.on(message("text"), async (ctx) => {
	const text = ctx.message.text.trim();
	if (text.startsWith("/")) return;

	stats.recordUser(ctx.from.id);

	const urls = extractUrls(text);
	if (!urls.length) return;

	const wait = checkCooldown(ctx.from.id);
	if (wait > 0)
		return ctx.reply(`Please wait ${wait}s before sending another link.`);

	const url = urls.find((u) => identifyPlatform(u));
	if (!url)
		return ctx.reply("Unsupported platform. Use /help to see the list.");

	const platform = identifyPlatform(url);
	const isTikTok = platform === "TikTok";
	const isInstagram = platform === "Instagram";

	const [statusMsg] = await Promise.all([
		ctx.replyWithHTML(
			`Downloading from <b>${platform}</b>...\n<i>Please wait.</i>`,
			{ reply_to_message_id: ctx.message.message_id }
		),
		queue.acquire(ctx.from.id),
	]);

	let filePath = null;
	let imagePaths = null;

	try {
		stats.recordAttempt();

		let result;
		if (isInstagram && isInstagramGallery(url)) {
			await editStatus(ctx, statusMsg.message_id, "Downloading images...");
			result = await downloadImages(url);
		} else {
			try {
				result = await download(url);
			} catch (videoErr) {
				// If TikTok video download fails, try image slideshow fallback
				if (isTikTok && videoErr instanceof DownloadError) {
					await editStatus(ctx, statusMsg.message_id, "Downloading images...");
					result = await downloadImages(url);
				} else {
					throw videoErr;
				}
			}
		}

		if (result.type === "images") {
			imagePaths = result.imagePaths;
			const { title, uploader, count } = result;

			const caption = `<b>${escapeHtml(title)}</b>\n${escapeHtml(uploader)} | ${platform} | ${count} image${count > 1 ? "s" : ""}`;

			editStatus(ctx, statusMsg.message_id, "Uploading images...").catch(() => {});

			// Telegram media groups: max 10 items
			const chunks = [];
			for (let i = 0; i < imagePaths.length; i += 10)
				chunks.push(imagePaths.slice(i, i + 10));

			for (let i = 0; i < chunks.length; i++) {
				const chunk = chunks[i];
				const mediaGroup = chunk.map((p, idx) => ({
					type: "photo",
					media: { source: createReadStream(p) },
					...(i === 0 && idx === 0 ? { caption, parse_mode: "HTML" } : {}),
				}));
				await ctx.replyWithMediaGroup(mediaGroup, {
					reply_to_message_id: ctx.message.message_id,
				});
			}

			stats.recordSuccess(platform, ctx.from.id);

			Promise.all([
				cleanupImages(imagePaths),
				ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {}),
			]).catch(() => {});
			imagePaths = null;

		} else {
			filePath = result.filePath;
			const { title, duration, uploader, fileSize } = result;

			const mins = Math.floor(duration / 60);
			const secs = String(Math.floor(duration % 60)).padStart(2, "0");
			const caption =
				`<b>${escapeHtml(title)}</b>\n` +
				`${escapeHtml(uploader)} | ${platform}` +
				(duration ? ` | ${mins}:${secs}` : "") +
				`\n${formatBytes(fileSize)}`;

			editStatus(ctx, statusMsg.message_id, "Uploading...").catch(() => {});

			await ctx.replyWithVideo(
				{ source: createReadStream(filePath) },
				{
					caption,
					parse_mode: "HTML",
					supports_streaming: true,
					reply_to_message_id: ctx.message.message_id,
				}
			);

			stats.recordSuccess(platform, ctx.from.id);

			Promise.all([
				cleanup(filePath),
				ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {}),
			]).catch(() => {});
			filePath = null;
		}

	} catch (err) {
		let errText;
		if (err instanceof FileTooLargeError) {
			stats.recordTooLarge();
			errText = `<b>File too large</b>\n\n${escapeHtml(err.message)}`;
		} else if (err instanceof DownloadError) {
			stats.recordFailure();
			errText = `<b>Download failed</b>\n\n${escapeHtml(err.message)}`;
		} else {
			stats.recordFailure();
			console.error(err);
			errText = "<b>An unexpected error occurred.</b>";
		}
		await editStatus(ctx, statusMsg.message_id, errText, { parse_mode: "HTML" });
	} finally {
		queue.release(ctx.from.id);
		if (filePath) cleanup(filePath).catch(() => {});
		if (imagePaths) cleanupImages(imagePaths).catch(() => {});
	}
});

bot.catch((err, ctx) => {
	console.error("Unhandled bot error:", err.message);
});

try {
	await bot.telegram.setMyCommands([
		{ command: "start",  description: "Welcome message" },
		{ command: "id",     description: "Get your Telegram user ID" },
		{ command: "help",   description: "How to use the bot" },
		{ command: "status", description: "Bot queue status" },
		{ command: "stats",  description: "Statistics (admin only)" },
	]);
} catch (err) {
	if (err.response?.error_code === 429) {
		const retryAfter = err.response.parameters?.retry_after ?? "unknown";
		console.warn(`setMyCommands rate limited — retry after ${retryAfter}s. Commands unchanged.`);
	} else {
		console.warn("setMyCommands failed:", err.message);
	}
}

async function shutdown(signal) {
	console.log(`Received ${signal}, shutting down...`);
	try { await bot.stop(signal); } catch {}
	process.exit(0);
}

bot.launch({ dropPendingUpdates: true });
console.log("Bot is running...");

// Periodic cleanup of idle per-user semaphores
setInterval(() => queue.cleanupIdleUsers(), 600_000).unref();
// Periodic cleanup of stale stats entries
setInterval(() => stats.cleanup(), 3_600_000).unref();

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
