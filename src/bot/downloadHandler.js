import { extractUrls, identifyPlatform, escapeHtml } from "../utils.js";
import { fetchMedia, cleanupResult, DownloadError, FileTooLargeError } from "../media/downloader.js";
import { stats } from "../stats.js";
import { queue } from "../queue.js";
import { checkCooldown } from "./cooldown.js";
import { editStatus, sendVideo, sendImages } from "./telegram.js";

// Platforms whose links may point at a photo post rather than a video.
const IMAGE_FALLBACK_PLATFORMS = new Set(["TikTok", "Instagram"]);

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

	const platform = identifyPlatform(url);

	await queue.acquire(ctx.from.id);

	let statusMsg;
	let result = null;

	try {
		statusMsg = await ctx.replyWithHTML(
			`Downloading from <b>${platform}</b>...\n<i>Please wait.</i>`,
			{ reply_to_message_id: ctx.message.message_id }
		);

		stats.recordAttempt();

		result = await fetchMedia(url, {
			imageFallback: IMAGE_FALLBACK_PLATFORMS.has(platform),
			onImageFallback: () => editStatus(ctx, statusMsg.message_id, "Downloading images..."),
		});

		const uploading = result.type === "images" ? "Uploading images..." : "Uploading...";
		editStatus(ctx, statusMsg.message_id, uploading).catch(() => {});

		if (result.type === "images") await sendImages(ctx, result, platform);
		else await sendVideo(ctx, result, platform);

		stats.recordSuccess(platform, ctx.from.id);
		ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
	} catch (err) {
		const errText = describeError(err);
		if (statusMsg) await editStatus(ctx, statusMsg.message_id, errText, { parse_mode: "HTML" });
	} finally {
		queue.release(ctx.from.id);
		if (result) cleanupResult(result).catch(() => {});
	}
}
