import { spawn } from "child_process";
import { stat, readdir, unlink, access } from "fs/promises";
import { constants as fsConstants } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import { DOWNLOAD_DIR, MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_MB, COOKIES_FILE } from "./config.js";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export class DownloadError extends Error {}
export class FileTooLargeError extends Error {}

const TIMEOUT_MS = 180_000;

const INSTAGRAM_APIS = ["web", "ios", "android"];

/**
 * Check if a DownloadError is Instagram auth/media related and might be resolved
 * by trying a different extractor API.
 * @param {Error} err
 * @returns {boolean}
 */
function isInstagramAuthError(err) {
	const msg = err.message || "";
	return /empty media response|sign\s*in|login|logged\s*in|authentication/i.test(msg);
}

const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** @type {{ cmd: string, pre: string[] }[]} */
const RUNNER_CANDIDATES = [
	{ cmd: "yt-dlp",  pre: [] },
	{ cmd: "python",  pre: ["-m", "yt_dlp"] },
	{ cmd: "python3", pre: ["-m", "yt_dlp"] },
	{ cmd: "py",      pre: ["-m", "yt_dlp"] },
];

/** @type {{ cmd: string, pre: string[] } | null} */
let _runner = null;

/**
 * @param {string} outTemplate
 * @param {string|null} cookiesFile
 * @param {string} [instagramApi="web"]
 * @returns {string[]}
 */
function buildArgs(outTemplate, cookiesFile, instagramApi = "web") {
	const args = [
		"--format",
		[
			"best[ext=mp4]",
			"bestvideo[ext=mp4]+bestaudio[ext=m4a]",
			"best",
		].join("/"),
		"--merge-output-format", "mp4",
		"--postprocessor-args",
		"ffmpeg:-c:v copy -c:a copy -movflags +faststart",
		"--no-playlist",
		"--concurrent-fragments", "16",
		"--socket-timeout", "15",
		"--retries", "3",
		"--fragment-retries", "5",
		"--buffer-size", "16K",
		"--http-chunk-size", "10M",
		"--max-filesize", `${MAX_FILE_SIZE_MB}M`,
		"--geo-bypass",
		"--user-agent", USER_AGENT,
		"--extractor-args",
		[
			"tiktok:api_hostname=api22-normal-c-useast2a.tiktokv.com",
			`instagram:api=${instagramApi}`,
		].join(";"),
		"--no-warnings",
		"--output", outTemplate,
		"--print-json",
		"--no-simulate",
	];

	if (cookiesFile) {
		args.push("--cookies", cookiesFile);
	}

	return args;
}

/**
 * @param {string} outTemplate
 * @param {string|null} cookiesFile
 * @param {string} [instagramApi="web"]
 * @returns {string[]}
 */
function buildImageArgs(outTemplate, cookiesFile, instagramApi = "web") {
	const args = [
		"--format", "images",
		"--socket-timeout", "15",
		"--retries", "3",
		"--geo-bypass",
		"--user-agent", USER_AGENT,
		"--extractor-args",
		[
			"tiktok:api_hostname=api22-normal-c-useast2a.tiktokv.com",
			`instagram:api=${instagramApi}`,
		].join(";"),
		"--no-warnings",
		"--output", outTemplate,
		"--print-json",
		"--no-simulate",
	];

	if (cookiesFile) {
		args.push("--cookies", cookiesFile);
	}

	return args;
}

/**
 * @param {string} p
 * @returns {Promise<boolean>}
 */
async function fileExists(p) {
	try { await access(p, fsConstants.F_OK); return true; } catch { return false; }
}

/**
 * Find the downloaded video file matching a prefix.
 * @param {string} dir
 * @param {string} prefix
 * @returns {Promise<string|null>}
 */
async function findDownloadedFile(dir, prefix) {
	const mp4 = join(dir, `${prefix}.mp4`);
	if (await fileExists(mp4)) return mp4;

	const files = (await readdir(dir)).filter((f) => {
		if (!f.startsWith(prefix)) return false;
		const ext = f.slice(f.lastIndexOf(".")).toLowerCase();
		return !IMAGE_EXTS.has(ext);
	});
	if (!files.length) return null;

	const preferred =
		files.find((f) => f.endsWith(".mp4")) ??
		files.find((f) => f.endsWith(".webm")) ??
		files[0];
	return join(dir, preferred);
}

/**
 * Find downloaded image files matching a prefix, sorted numerically.
 * @param {string} dir
 * @param {string} prefix
 * @returns {Promise<string[]>}
 */
async function findDownloadedImages(dir, prefix) {
	const files = await readdir(dir);
	const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`^${escaped}\\.(\\d+)\\.[^.]+$`);
	return files
		.filter((f) => {
			if (!f.startsWith(prefix)) return false;
			const ext = f.slice(f.lastIndexOf(".")).toLowerCase();
			return IMAGE_EXTS.has(ext);
		})
		.sort((a, b) => {
			const ma = a.match(re);
			const mb = b.match(re);
			if (ma && mb) return Number(ma[1]) - Number(mb[1]);
			return a.localeCompare(b, undefined, { numeric: true });
		})
		.map((f) => join(dir, f));
}

/**
 * Extract a human-readable error message from yt-dlp stderr.
 * @param {string} raw
 * @returns {string}
 */
function extractError(raw) {
	// Log full stderr for debugging
	console.warn("yt-dlp stderr:\n", raw);

	let line = raw
		.split(/\r?\n/)
		.find((l) => l.includes("ERROR:"))
		?.replace(/^.*ERROR:\s*/, "")
		.trim();

	if (!line) return "Download failed — the link may be private or unsupported.";

	line = line.replace(/\s*;\s*please report this issue.*/i, "").trim();
	line = line.replace(/\s*Confirm you are on the latest version.*/i, "").trim();
	line = line.replace(/\s*See\s+https?:\/\/[^\s]+\s+for\s+how\s+to\s+manually\s+pass\s+cookies.*/i, "").trim();
	line = line.replace(/\s*Otherwise,?\s*if\s+the\s+post\s+is\s+accessible.*/i, "").trim();

	if (/Unable to extract webpage video data/i.test(line))
		return "TikTok extraction failed. Try another URL or retry later.";

	if (/empty media response/i.test(line))
		return "Instagram returned no data. This post may require login. Ask the admin to configure cookies.";

	if (/(sign\s*in|login|logged\s*in|authentication|confirm.*not.*bot)/i.test(line))
		return "This content requires authentication on the source platform.";

	return line || "Download failed — the link may be private or unsupported.";
}

/**
 * Spawn yt-dlp and wait for completion.
 * @param {{ cmd: string, pre: string[] }} runner
 * @param {string[]} args
 * @returns {Promise<string>} stdout
 */
function spawnRunner(runner, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(runner.cmd, [...runner.pre, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;

		const settle = (fn, val) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (!child.killed) try { child.kill("SIGTERM"); } catch { }
			fn(val);
		};

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, TIMEOUT_MS);

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (c) => { stdout += c; });

		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (c) => { stderr += c; });

		child.on("error", (err) => {
			if (err.code === "ENOENT") {
				const e = new DownloadError(`${runner.cmd}: binary not found.`);
				e.code = "NOT_FOUND";
				settle(reject, e);
			} else {
				settle(reject, new DownloadError(`Failed to launch ${runner.cmd}: ${err.message}`));
			}
		});

		child.on("close", (code) => {
			if (timedOut) {
				settle(reject, new DownloadError(`Download timed out after ${TIMEOUT_MS / 1000}s.`));
				return;
			}
			if (code !== 0) {
				if (/No module named yt_dlp/i.test(stderr)) {
					const e = new DownloadError(`${runner.cmd}: yt_dlp module missing.`);
					e.code = "NOT_FOUND";
					settle(reject, e);
					return;
				}
				settle(reject, new DownloadError(extractError(stderr)));
				return;
			}
			settle(resolve, stdout);
		});
	});
}

/**
 * Detect and cache yt-dlp runner.
 * @returns {Promise<{ cmd: string, pre: string[] }>}
 */
async function getRunner() {
	if (_runner) return _runner;

	for (const candidate of RUNNER_CANDIDATES) {
		try {
			await spawnRunner(candidate, ["--version"]);
			_runner = candidate;
			return _runner;
		} catch (err) {
			if (err.code === "NOT_FOUND") continue;
			continue;
		}
	}

	throw new DownloadError(
		"yt-dlp not found. Run: pip install yt-dlp  OR  add the yt-dlp binary to PATH."
	);
}

getRunner().catch(() => {});

/** @typedef {{ type: "video", filePath: string, title: string, duration: number, uploader: string, platform: string, fileSize: number }} VideoResult */
/** @typedef {{ type: "images", imagePaths: string[], title: string, uploader: string, platform: string, count: number }} ImagesResult */

/**
 * Core video download — tries once with the given Instagram API.
 * @param {string} url
 * @param {string} instagramApi
 * @returns {Promise<VideoResult>}
 */
async function doDownload(url, instagramApi) {
	const runner = await getRunner();

	const fileId = randomBytes(6).toString("hex");
	const outTemplate = join(DOWNLOAD_DIR, `${fileId}.%(ext)s`);

	const cookiesArg =
		COOKIES_FILE && (await fileExists(COOKIES_FILE)) ? COOKIES_FILE : null;

	const args = [...buildArgs(outTemplate, cookiesArg, instagramApi), url];

	let stdout;
	try {
		stdout = await spawnRunner(runner, args);
	} catch (err) {
		const partial = await findDownloadedFile(DOWNLOAD_DIR, fileId);
		if (partial) unlink(partial).catch(() => {});
		throw err;
	}

	let info = {};
	try {
		const lastJson = stdout
			.trim()
			.split("\n")
			.findLast((l) => l.startsWith("{"));
		if (lastJson) info = JSON.parse(lastJson);
	} catch { }

	const filePath = await findDownloadedFile(DOWNLOAD_DIR, fileId);
	if (!filePath) throw new DownloadError("File not found after download.");

	const { size } = await stat(filePath);
	if (size > MAX_FILE_SIZE_BYTES) {
		unlink(filePath).catch(() => {});
		throw new FileTooLargeError(
			`File is ${(size / 1024 / 1024).toFixed(1)} MB — exceeds the ${MAX_FILE_SIZE_MB} MB Telegram limit.`
		);
	}

	return {
		type:     "video",
		filePath,
		title:    info.title         || "Video",
		duration: info.duration      || 0,
		uploader: info.uploader      || info.channel || "Unknown",
		platform: info.extractor_key || "Unknown",
		fileSize: size,
	};
}

/**
 * Core image download — tries once with the given Instagram API.
 * @param {string} url
 * @param {string} instagramApi
 * @returns {Promise<ImagesResult>}
 */
async function doDownloadImages(url, instagramApi) {
	const runner = await getRunner();

	const fileId = randomBytes(6).toString("hex");
	const outTemplate = join(DOWNLOAD_DIR, `${fileId}.%(autonumber)s.%(ext)s`);

	const cookiesArg =
		COOKIES_FILE && (await fileExists(COOKIES_FILE)) ? COOKIES_FILE : null;

	const args = [...buildImageArgs(outTemplate, cookiesArg, instagramApi), url];

	let stdout;
	try {
		stdout = await spawnRunner(runner, args);
	} catch (err) {
		const images = await findDownloadedImages(DOWNLOAD_DIR, fileId);
		for (const img of images) unlink(img).catch(() => {});
		throw err;
	}

	let info = {};
	try {
		const lastJson = stdout
			.trim()
			.split("\n")
			.findLast((l) => l.startsWith("{"));
		if (lastJson) info = JSON.parse(lastJson);
	} catch { }

	const imagePaths = await findDownloadedImages(DOWNLOAD_DIR, fileId);
	if (!imagePaths.length) throw new DownloadError("No images found after download.");

	return {
		type:     "images",
		imagePaths,
		title:    info.title    || "Images",
		uploader: info.uploader || info.channel || "Unknown",
		platform: info.extractor_key || "TikTok",
		count:    imagePaths.length,
	};
}

/**
 * Download a video from a URL.
 * Tries Instagram API fallbacks (web → ios → android) on auth errors.
 * @param {string} url
 * @returns {Promise<VideoResult>}
 */
export async function download(url) {
	const isInstagram = url.includes("instagram.com");
	const apis = isInstagram ? INSTAGRAM_APIS : ["web"];
	let lastErr;

	for (const api of apis) {
		try {
			return await doDownload(url, api);
		} catch (err) {
			lastErr = err;
			if (!isInstagram || !isInstagramAuthError(err)) throw err;
		}
	}
	throw lastErr;
}

/**
 * Download images (slideshow/gallery) from a URL.
 * Tries Instagram API fallbacks (web → ios → android) on auth errors.
 * @param {string} url
 * @returns {Promise<ImagesResult>}
 */
export async function downloadImages(url) {
	const isInstagram = url.includes("instagram.com");
	const apis = isInstagram ? INSTAGRAM_APIS : ["web"];
	let lastErr;

	for (const api of apis) {
		try {
			return await doDownloadImages(url, api);
		} catch (err) {
			lastErr = err;
			if (!isInstagram || !isInstagramAuthError(err)) throw err;
		}
	}
	throw lastErr;
}

/**
 * Delete downloaded image files.
 * @param {string[]} imagePaths
 */
export async function cleanupImages(imagePaths) {
	await Promise.all(imagePaths.map((p) => unlink(p).catch(() => {})));
}

/**
 * Delete a downloaded file.
 * @param {string} filePath
 */
export async function cleanup(filePath) {
	if (filePath) await unlink(filePath).catch(() => {});
}
