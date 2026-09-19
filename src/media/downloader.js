import { stat, unlink } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";

import { DOWNLOAD_DIR, MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_MB, COOKIES_FILE } from "../config.js";
import { runYtDlp, isAuthError } from "./ytdlp.js";
import { buildVideoArgs, buildImageArgs } from "./args.js";
import { findDownloadedFile, findDownloadedImages, fileExists, cleanup, cleanupImages } from "./files.js";
import { ensureStreamableMp4 } from "./mp4.js";
import { DownloadError, FileTooLargeError } from "./errors.js";

export { DownloadError, FileTooLargeError };

/** @typedef {{ type: "video", filePath: string, title: string, duration: number, width: number, height: number, uploader: string, platform: string, fileSize: number }} VideoResult */
/** @typedef {{ type: "images", imagePaths: string[], title: string, uploader: string, platform: string, count: number }} ImagesResult */
/** @typedef {VideoResult | ImagesResult} MediaResult */

// yt-dlp's Instagram extractor only knows these `app_id` aliases (web → www.instagram.com, ios → i.instagram.com).
const INSTAGRAM_APIS = ["web", "ios"];

const isInstagramUrl = (url) => url.includes("instagram.com");

/**
 * yt-dlp prints one JSON document per downloaded entry; the last one describes the final file.
 * @param {string} stdout
 * @returns {Record<string, any>}
 */
function parseInfo(stdout) {
	try {
		const lastJson = stdout.trim().split("\n").findLast((l) => l.startsWith("{"));
		return lastJson ? JSON.parse(lastJson) : {};
	} catch {
		return {};
	}
}

async function discardPartial(fileId, isVideo) {
	if (isVideo) {
		const partial = await findDownloadedFile(DOWNLOAD_DIR, fileId);
		if (partial) unlink(partial).catch(() => {});
	} else {
		for (const img of await findDownloadedImages(DOWNLOAD_DIR, fileId)) unlink(img).catch(() => {});
	}
}

/**
 * @param {string} fileId
 * @param {Record<string, any>} info
 * @returns {Promise<VideoResult>}
 */
async function finishVideo(fileId, info) {
	const filePath = await findDownloadedFile(DOWNLOAD_DIR, fileId);
	if (!filePath) throw new DownloadError("File not found after download.");

	const { size } = await stat(filePath);
	if (size > MAX_FILE_SIZE_BYTES) {
		unlink(filePath).catch(() => {});
		throw new FileTooLargeError(
			`File is ${(size / 1024 / 1024).toFixed(1)} MB — exceeds the ${MAX_FILE_SIZE_MB} MB Telegram limit.`
		);
	}

	// Best effort: a fragmented file still plays on desktop, so never fail the download over it.
	try {
		const { remuxed } = await ensureStreamableMp4(filePath);
		if (remuxed) console.log(`Normalized fragmented MP4: ${filePath}`);
	} catch (err) {
		console.warn(`Could not normalize ${filePath}: ${err.message}`);
	}

	return {
		type:     "video",
		filePath,
		title:    info.title         || "Video",
		duration: info.duration      || 0,
		width:    info.width         || 0,
		height:   info.height        || 0,
		uploader: info.uploader      || info.channel || "Unknown",
		platform: info.extractor_key || "Unknown",
		fileSize: size,
	};
}

/**
 * @param {string} fileId
 * @param {Record<string, any>} info
 * @returns {Promise<ImagesResult>}
 */
async function finishImages(fileId, info) {
	const imagePaths = await findDownloadedImages(DOWNLOAD_DIR, fileId);
	if (!imagePaths.length) throw new DownloadError("No images found after download.");

	return {
		type:     "images",
		imagePaths,
		title:    info.title         || "Images",
		uploader: info.uploader      || info.channel || "Unknown",
		platform: info.extractor_key || "TikTok",
		count:    imagePaths.length,
	};
}

/**
 * One yt-dlp run.
 * @param {string} url
 * @param {string} instagramApi
 * @param {"video"|"images"} mode
 * @returns {Promise<MediaResult>}
 */
async function attempt(url, instagramApi, mode) {
	const isVideo = mode === "video";
	const fileId = randomBytes(6).toString("hex");

	const opts = {
		outTemplate: join(DOWNLOAD_DIR, isVideo ? `${fileId}.%(ext)s` : `${fileId}.%(autonumber)s.%(ext)s`),
		cookiesFile: COOKIES_FILE && (await fileExists(COOKIES_FILE)) ? COOKIES_FILE : null,
		instagramApi,
		isInstagram: isInstagramUrl(url),
	};
	const args = [...(isVideo ? buildVideoArgs(opts) : buildImageArgs(opts)), url];

	let stdout;
	try {
		stdout = await runYtDlp(args);
	} catch (err) {
		await discardPartial(fileId, isVideo);
		throw err;
	}

	const info = parseInfo(stdout);
	return isVideo ? finishVideo(fileId, info) : finishImages(fileId, info);
}

/**
 * Retry Instagram with the next app_id (web → ios) on auth / rate-limit errors.
 * @param {string} url
 * @param {"video"|"images"} mode
 * @returns {Promise<MediaResult>}
 */
async function withInstagramFallback(url, mode) {
	const apis = isInstagramUrl(url) ? INSTAGRAM_APIS : ["web"];
	let lastErr;

	for (const api of apis) {
		try {
			return await attempt(url, api, mode);
		} catch (err) {
			lastErr = err;
			if (apis.length === 1 || !isAuthError(err)) throw err;
			console.warn(`Instagram app_id=${api} failed (${err.message}), trying next.`);
		}
	}
	throw lastErr;
}

/**
 * @param {string} url
 * @returns {Promise<VideoResult>}
 */
export function download(url) {
	return /** @type {Promise<VideoResult>} */ (withInstagramFallback(url, "video"));
}

/**
 * TikTok slideshow, Instagram photo post or carousel.
 * @param {string} url
 * @returns {Promise<ImagesResult>}
 */
export function downloadImages(url) {
	return /** @type {Promise<ImagesResult>} */ (withInstagramFallback(url, "images"));
}

/**
 * Download whatever the post holds. Video first; when the platform also hosts photo posts,
 * a non-auth failure usually means there was no video, so retry in image mode. Auth and
 * rate-limit failures would fail identically in image mode, so they surface directly.
 *
 * @param {string} url
 * @param {{ imageFallback?: boolean, onImageFallback?: () => Promise<void> | void }} [opts]
 * @returns {Promise<MediaResult>}
 */
export async function fetchMedia(url, { imageFallback = false, onImageFallback } = {}) {
	try {
		return await download(url);
	} catch (err) {
		if (!imageFallback || !(err instanceof DownloadError) || isAuthError(err)) throw err;
		await onImageFallback?.();
		return downloadImages(url);
	}
}

/**
 * Delete the files a result points at.
 * @param {MediaResult} result
 */
export function cleanupResult(result) {
	return result.type === "images" ? cleanupImages(result.imagePaths) : cleanup(result.filePath);
}
