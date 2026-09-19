import { open, rename, unlink } from "fs/promises";
import { spawn } from "child_process";

// Top-level boxes that only exist in a fragmented MP4.
const FRAGMENT_BOXES = new Set(["moof", "styp", "mfra"]);

/**
 * @typedef {object} Mp4Layout
 * @property {boolean} isMp4       has an ftyp and a moov box
 * @property {boolean} fragmented  carries moof fragments instead of a full sample table
 * @property {boolean} faststart   moov precedes mdat, so playback can start while streaming
 */

/**
 * Walk the top-level box structure without reading the media payload.
 * @param {string} filePath
 * @returns {Promise<Mp4Layout>}
 */
export async function inspectMp4(filePath) {
	const fh = await open(filePath, "r");
	try {
		const { size } = await fh.stat();
		const header = Buffer.alloc(16);
		let offset = 0;
		let sawFtyp = false;
		let moovAt = -1;
		let mdatAt = -1;
		let fragmented = false;

		while (offset + 8 <= size) {
			const { bytesRead } = await fh.read(header, 0, 16, offset);
			if (bytesRead < 8) break;

			let boxSize = header.readUInt32BE(0);
			const type = header.toString("latin1", 4, 8);
			let headerLen = 8;

			if (boxSize === 1) {
				if (bytesRead < 16) break;
				boxSize = Number(header.readBigUInt64BE(8));
				headerLen = 16;
			} else if (boxSize === 0) {
				boxSize = size - offset;
			}
			if (boxSize < headerLen) break;

			if (type === "ftyp") sawFtyp = true;
			else if (type === "moov" && moovAt < 0) moovAt = offset;
			else if (type === "mdat" && mdatAt < 0) mdatAt = offset;
			else if (FRAGMENT_BOXES.has(type)) fragmented = true;

			offset += boxSize;
		}

		return {
			isMp4: sawFtyp && moovAt >= 0,
			fragmented,
			faststart: moovAt >= 0 && (mdatAt < 0 || moovAt < mdatAt),
		};
	} finally {
		await fh.close();
	}
}

/**
 * @param {string[]} args
 * @returns {Promise<void>}
 */
function runFfmpeg(args) {
	return new Promise((resolve, reject) => {
		const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (c) => { stderr += c; });
		child.on("error", (err) => reject(new Error(`ffmpeg: ${err.message}`)));
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().split("\n").pop() || "unknown error"}`));
		});
	});
}

/**
 * Rewrite the container in place when it would not play everywhere.
 *
 * DASH sources arrive as fragmented MP4 — moof boxes and no stss keyframe index. Desktop
 * players parse the fragments, but mobile decoders rely on the moov index and show a frozen
 * picture while the audio keeps playing. yt-dlp only rewrites the container when it merges
 * separate streams, and both --remux-video and --fixup skip a file that is already .mp4, so a
 * single video-only format ships fragmented unless it is normalized here. The rewrite is a
 * stream copy: no re-encoding, same quality, and moov moved to the front.
 *
 * @param {string} filePath
 * @returns {Promise<Mp4Layout & { remuxed: boolean }>}
 */
export async function ensureStreamableMp4(filePath) {
	const layout = await inspectMp4(filePath);
	if (!layout.isMp4 || (!layout.fragmented && layout.faststart)) {
		return { ...layout, remuxed: false };
	}

	const tmp = `${filePath}.remux.mp4`;
	try {
		await runFfmpeg([
			"-y", "-v", "error",
			"-i", filePath,
			"-map", "0:v:0", "-map", "0:a?",
			"-c", "copy",
			"-movflags", "+faststart",
			tmp,
		]);
		await rename(tmp, filePath);
	} catch (err) {
		await unlink(tmp).catch(() => {});
		throw err;
	}
	return { ...layout, remuxed: true };
}
