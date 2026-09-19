import { open, rename, unlink } from "fs/promises";
import { spawn } from "child_process";

// Top-level boxes that only exist in a fragmented MP4.
const FRAGMENT_BOXES = new Set(["moof", "styp", "mfra"]);

// Telegram's mobile clients decode in hardware. H.264 and AAC are the only pair every
// device is guaranteed to handle; VP9 and AV1 fall back to software on desktop but show a
// frozen first frame on phones, with the audio track still playing.
const SAFE_VIDEO_CODEC = "h264";
const SAFE_AUDIO_CODEC = "aac";

const TRANSCODE_TIMEOUT_MS = 600_000;

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
 * @param {string} bin
 * @param {string[]} args
 * @param {number} [timeoutMs]
 * @returns {Promise<string>} stdout
 */
function run(bin, args, timeoutMs = 60_000) {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stdout = "";
		let stderr = "";
		let settled = false;

		const settle = (fn, val) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (!child.killed) try { child.kill("SIGKILL"); } catch {}
			fn(val);
		};

		const timer = setTimeout(
			() => settle(reject, new Error(`${bin} timed out after ${timeoutMs / 1000}s`)),
			timeoutMs
		);

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (c) => { stdout += c; });
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (c) => { stderr += c; });
		child.on("error", (err) => settle(reject, new Error(`${bin}: ${err.message}`)));
		child.on("close", (code) => {
			if (code === 0) settle(resolve, stdout);
			else settle(reject, new Error(`${bin} exited with ${code}: ${stderr.trim().split("\n").pop() || "unknown error"}`));
		});
	});
}

/**
 * Codecs actually present in the file, as ffprobe reports them.
 * @param {string} filePath
 * @returns {Promise<{ video: string|null, audio: string|null }>}
 */
export async function probeCodecs(filePath) {
	const out = await run("ffprobe", [
		"-v", "error",
		"-show_entries", "stream=codec_type,codec_name",
		"-of", "csv=p=0",
		filePath,
	]);

	const codecs = { video: null, audio: null };
	for (const line of out.trim().split(/\r?\n/)) {
		const [name, type] = line.split(",").map((s) => s?.trim());
		// ffprobe's field order follows the stream, so accept either arrangement.
		const [codec, kind] = type === "video" || type === "audio" ? [name, type] : [type, name];
		if (kind === "video" && !codecs.video) codecs.video = codec ?? null;
		if (kind === "audio" && !codecs.audio) codecs.audio = codec ?? null;
	}
	return codecs;
}

/**
 * Decide what the file needs before Telegram can play it everywhere.
 * @param {string} filePath
 * @returns {Promise<{ action: "none"|"remux"|"transcode", reason: string, layout: Mp4Layout, codecs: { video: string|null, audio: string|null } }>}
 */
export async function planNormalization(filePath) {
	const [layout, codecs] = await Promise.all([inspectMp4(filePath), probeCodecs(filePath)]);

	// A codec a phone cannot decode in hardware shows a frozen first frame while the audio
	// plays on — re-encoding is the only cure, so it takes precedence over container repairs.
	if (codecs.video && codecs.video !== SAFE_VIDEO_CODEC)
		return { action: "transcode", reason: `video codec ${codecs.video}`, layout, codecs };
	if (codecs.audio && codecs.audio !== SAFE_AUDIO_CODEC)
		return { action: "transcode", reason: `audio codec ${codecs.audio}`, layout, codecs };
	if (!layout.isMp4)
		return { action: "transcode", reason: "not an MP4 container", layout, codecs };

	// Fragmented MP4 carries moof boxes and no stss keyframe index. Desktop players parse the
	// fragments; mobile decoders rely on the moov index. yt-dlp only rewrites the container
	// when it merges separate streams, and --remux-video/--fixup skip a file already named
	// .mp4, so a single video-only format ships fragmented unless it is repaired here.
	if (layout.fragmented) return { action: "remux", reason: "fragmented MP4", layout, codecs };
	if (!layout.faststart) return { action: "remux", reason: "moov after mdat", layout, codecs };

	return { action: "none", reason: "already streamable", layout, codecs };
}

/**
 * Make the file playable on every Telegram client, in place.
 *
 * Repairs the container with a stream copy when only its layout is wrong, and falls back to
 * re-encoding to H.264/AAC when the codecs themselves are not hardware-decodable on phones.
 *
 * @param {string} filePath
 * @returns {Promise<{ action: "none"|"remux"|"transcode", reason: string }>}
 */
export async function ensurePlayable(filePath) {
	const { action, reason } = await planNormalization(filePath);
	if (action === "none") return { action, reason };

	const tmp = `${filePath}.fix.mp4`;
	const args =
		action === "remux"
			? ["-c", "copy"]
			: [
				"-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
				"-profile:v", "high", "-level", "4.0", "-pix_fmt", "yuv420p",
				"-c:a", "aac", "-b:a", "128k", "-ac", "2",
			];

	try {
		await run(
			"ffmpeg",
			["-y", "-v", "error", "-i", filePath, "-map", "0:v:0", "-map", "0:a?", ...args, "-movflags", "+faststart", tmp],
			action === "transcode" ? TRANSCODE_TIMEOUT_MS : 60_000
		);
		await rename(tmp, filePath);
	} catch (err) {
		await unlink(tmp).catch(() => {});
		throw err;
	}
	return { action, reason };
}
