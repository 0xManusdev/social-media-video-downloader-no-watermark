import { Markup } from "telegraf";

import { extractUrls, identifyPlatform, escapeHtml } from "../utils.js";
import { fetchMedia, cleanupResult, DownloadError, FileTooLargeError } from "../media/downloader.js";
import { stats } from "../stats.js";
import { queue } from "../queue.js";
import { checkCooldown } from "./cooldown.js";
import { saveForRetry, popForRetry } from "./retryStore.js";
import { editStatus, sendVideo, sendImages } from "./telegram.js";

// Platforms whose links may point at a photo post rather than a video.
const IMAGE_FALLBACK_PLATFORMS = new Set(["TikTok", "Instagram"]);

const RETRY_PREFIX = "retry:";
export const RETRY_ACTION_PATTERN = new RegExp(`^${RETRY_PREFIX}`);

// Telegram throttles editMessageText per chat; only push an update when the number
// changed meaningfully or enough time passed, so we stay well under that limit.
const PROGRESS_MIN_INTERVAL_MS = 3000;
const PROGRESS_MIN_DELTA = 5;

/**
 * @param {import("telegraf").Context} ctx
 * @param {number} msgId
 * @param {string} platform
 * @returns {(percent: string) => void}
 */
function makeProgressReporter(ctx, msgId, platform) {
	let lastEdit = 0;
	let lastPct = -Infinity;
	return (percentStr) => {
		const pct = parseFloat(percentStr);
		if (!Number.isFinite(pct)) return;

		const now = Date.now();
		const isDone = pct >= 100;
		if (!isDone && now - lastEdit < PROGRESS_MIN_INTERVAL_MS && pct - lastPct < PROGRESS_MIN_DELTA) return;

		lastEdit = now;
		lastPct = pct;
		editStatus(
			ctx,
			msgId,
			`Downloading from <b>${platform}</b>...\n<i>${pct.toFixed(0)}%</i>`
		).catch(() => {});
	};
}

/**
 * @param {unknown} err
 * @returns {string} HTML for the status message
 */
function describeError(err) {
	if (err instanceof FileTooLargeError) {
		stats.recordTooLarge();
		return `<b>File too large</b>\n\n${escapeHtml(err.message)}`;
	}
	stats.recordFailure();
	if (err instanceof DownloadError) {
		return `<b>Download failed</b>\n\n${escapeHtml(err.message)}`;
	}
	console.error(err);
	return "<b>An unexpected error occurred.</b>";
}

/**
 * Run one download end to end: acquire a queue slot, report progress on a status message
 * (creating one if none is given, e.g. on the first attempt — or reusing one, e.g. on a
 * retry), then send the result. On failure, the status message gets a Retry button.
 *
 * @param {import("telegraf").Context} ctx
 * @param {{ url: string, platform: string, messageId?: number, replyToMessageId?: number }} opts
 */
async function runDownload(ctx, { url, platform, messageId, replyToMessageId }) {
	await queue.acquire(ctx.from.id);

	let msgId = messageId;
	let result = null;

	try {
		const startText = `Downloading from <b>${platform}</b>...\n<i>Please wait.</i>`;
		if (msgId) {
			await editStatus(ctx, msgId, startText, { parse_mode: "HTML" });
		} else {
			const sent = await ctx.replyWithHTML(startText, {
				...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
			});
			msgId = sent.message_id;
		}

		stats.recordAttempt();

		result = await fetchMedia(url, {
			imageFallback: IMAGE_FALLBACK_PLATFORMS.has(platform),
			onImageFallback: () => editStatus(ctx, msgId, "Downloading images..."),
			onProgress: makeProgressReporter(ctx, msgId, platform),
		});

		const uploading = result.type === "images" ? "Uploading images..." : "Uploading...";
		editStatus(ctx, msgId, uploading).catch(() => {});

		if (result.type === "images") await sendImages(ctx, result, platform, replyToMessageId);
		else await sendVideo(ctx, result, platform, replyToMessageId);

		stats.recordSuccess(platform, ctx.from.id);
		ctx.telegram.deleteMessage(ctx.chat.id, msgId).catch(() => {});
	} catch (err) {
		const errText = describeError(err);
		if (msgId) {
			const retryId = saveForRetry(url, ctx.from.id);
			await editStatus(ctx, msgId, errText, {
				parse_mode: "HTML",
				...Markup.inlineKeyboard([Markup.button.callback("🔄 Réessayer", `${RETRY_PREFIX}${retryId}`)]),
			});
		}
	} finally {
		queue.release(ctx.from.id);
		if (result) cleanupResult(result).catch(() => {});
	}
}

/**
 * Text-message handler: find a supported link, download it, send it back.
 * @param {import("telegraf").Context} ctx
 */
export async function handleTextMessage(ctx) {
	const text = ctx.message.text.trim();
	if (text.startsWith("/")) return;

	stats.recordUser(ctx.from.id);

	const urls = extractUrls(text);
	if (!urls.length) return;

	const url = urls.find((u) => identifyPlatform(u));
	if (!url) return ctx.reply("Unsupported platform. Use /help to see the list.");

	const wait = checkCooldown(ctx.from.id);
	if (wait > 0) return ctx.reply(`Please wait ${wait}s before sending another link.`);

	await runDownload(ctx, {
		url,
		platform: identifyPlatform(url),
		replyToMessageId: ctx.message.message_id,
	});
}

/**
 * "🔄 Réessayer" button handler: re-run a failed download from its saved URL, reusing the
 * same status message.
 * @param {import("telegraf").Context} ctx
 */
export async function handleRetryAction(ctx) {
	const id = ctx.callbackQuery.data.slice(RETRY_PREFIX.length);
	const url = popForRetry(id, ctx.from.id);
	if (!url) return ctx.answerCbQuery("This retry link expired — send the link again.", { show_alert: true });

	await ctx.answerCbQuery();

	const messageId = ctx.callbackQuery.message.message_id;

	const wait = checkCooldown(ctx.from.id);
	if (wait > 0) return editStatus(ctx, messageId, `Please wait ${wait}s before sending another link.`);

	await runDownload(ctx, {
		url,
		platform: identifyPlatform(url),
		messageId,
		replyToMessageId: ctx.callbackQuery.message.reply_to_message?.message_id,
	});
}
