import { createReadStream } from "fs";
import { escapeHtml, formatBytes } from "../utils.js";

const MEDIA_GROUP_LIMIT = 10;

/**
 * Edit a status message, ignoring the errors that only mean "nothing to do".
 * @param {import("telegraf").Context} ctx
 * @param {number} msgId
 * @param {string} text
 * @param {object} [extra]
 */
export async function editStatus(ctx, msgId, text, extra = {}) {
	try {
		await ctx.telegram.editMessageText(ctx.chat.id, msgId, undefined, text, extra);
	} catch (err) {
		const msg = err.message || "";
		const ignore = ["not modified", "message to edit not found", "message can't be edited"];
		if (!ignore.some((s) => msg.includes(s))) throw err;
	}
}

/**
 * @param {import("telegraf").Context} ctx
 * @param {import("../media/downloader.js").VideoResult} result
 * @param {string} platform
 * @param {number} [replyToMessageId]
 */
export async function sendVideo(ctx, result, platform, replyToMessageId) {
	const { filePath, title, duration, width, height, uploader, fileSize } = result;

	const mins = Math.floor(duration / 60);
	const secs = String(Math.floor(duration % 60)).padStart(2, "0");
	const caption =
		`<b>${escapeHtml(title)}</b>\n` +
		`${escapeHtml(uploader)} | ${platform}` +
		(duration ? ` | ${mins}:${secs}` : "") +
		`\n${formatBytes(fileSize)}`;

	// Dimensions and duration let clients size the player and seek before the download completes.
	await ctx.replyWithVideo(
		{ source: createReadStream(filePath) },
		{
			caption,
			parse_mode: "HTML",
			supports_streaming: true,
			...(duration ? { duration: Math.round(duration) } : {}),
			...(width && height ? { width, height } : {}),
			...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
		}
	);
}

/**
 * @param {import("telegraf").Context} ctx
 * @param {import("../media/downloader.js").ImagesResult} result
 * @param {string} platform
 * @param {number} [replyToMessageId]
 */
export async function sendImages(ctx, result, platform, replyToMessageId) {
	const { imagePaths, title, uploader, count } = result;
	const caption =
		`<b>${escapeHtml(title)}</b>\n` +
		`${escapeHtml(uploader)} | ${platform} | ${count} image${count > 1 ? "s" : ""}`;

	for (let i = 0; i < imagePaths.length; i += MEDIA_GROUP_LIMIT) {
		const chunk = imagePaths.slice(i, i + MEDIA_GROUP_LIMIT);
		const mediaGroup = chunk.map((p, idx) => ({
			type: "photo",
			media: { source: createReadStream(p) },
			...(i === 0 && idx === 0 ? { caption, parse_mode: "HTML" } : {}),
		}));
		await ctx.replyWithMediaGroup(mediaGroup, {
			...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
		});
	}
}
