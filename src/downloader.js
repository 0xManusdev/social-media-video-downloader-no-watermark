import { spawn } from "child_process";
import { stat, readdir, unlink, access } from "fs/promises";
import { constants as fsConstants } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import { DOWNLOAD_DIR, MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_MB, COOKIES_FILE } from "./config.js";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export class DownloadError extends Error {}
export class FileTooLargeError extends Error {}

// Minimum throughput assumed for a slow network, used to size the timeout
// so it scales with MAX_FILE_SIZE_MB instead of being a disconnected constant.
const MIN_THROUGHPUT_BYTES_PER_SEC = 300 * 1024; // 300 KB/s
const BASE_TIMEOUT_MS = 60_000; // metadata extraction + retries overhead
const DEFAULT_TIMEOUT_MS =
	BASE_TIMEOUT_MS + Math.ceil((MAX_FILE_SIZE_BYTES / MIN_THROUGHPUT_BYTES_PER_SEC) * 1000);
const ENV_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS);
const TIMEOUT_MS = ENV_TIMEOUT_MS > 0 ? ENV_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;

// Headroom under MAX_FILE_SIZE_MB for the audio track and container overhead, so the
// video stream alone is picked below the cap rather than blowing the Telegram limit.
const VIDEO_SIZE_CAP_MB = Math.max(MAX_FILE_SIZE_MB - 5, 5);

// yt-dlp's Instagram extractor only knows these `app_id` aliases (web → www.instagram.com, ios → i.instagram.com)
const INSTAGRAM_APIS = ["web", "ios"];

const AUTH_ERROR_RE =
	/(empty media response|sign\s*in|login|logged\s*in|authentication|rate-limit|not granting access|cookies are no longer valid)/i;

/**
 * True when the failure is an auth / rate-limit / access problem on the source platform,
 * i.e. retrying with the same credentials or a different mode is pointless.
 * @param {Error} err
 * @returns {boolean}
 */
export function isAuthError(err) {
	return Boolean(err?.authError) || AUTH_ERROR_RE.test(err?.message || "");
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
 * yt-dlp needs curl_cffi to impersonate a browser's TLS fingerprint. Without it Instagram
 * redirects every anonymous post to its login page, which yt-dlp reports as a rate-limit.
 * null until the probe has run.
 * @type {boolean|null}
 */
let _canImpersonate = null;

const IMPERSONATION_HINT =
	"yt-dlp has no browser impersonation (curl_cffi missing) — Instagram downloads will fail. " +
	'Use a build that bundles it (yt-dlp_linux) or run: pip install "yt-dlp[default,curl-cffi]"';

/**
 * @typedef {{ outTemplate: string, cookiesFile: string|null, instagramApi: string, isInstagram: boolean }} BuildOpts
 */

/**
 * CLI flags shared between video and image download modes.
 * @param {BuildOpts} opts
 * @returns {string[]}
 */
function buildBaseArgs({ outTemplate, cookiesFile, instagramApi, isInstagram }) {
	const args = [
		"--socket-timeout", "15",
		"--retries", "3",
		"--geo-bypass",
		// One --extractor-args per extractor: yt-dlp does not accept several IE keys in a single value
		"--extractor-args", "tiktok:api_hostname=api22-normal-c-useast2a.tiktokv.com",
		"--extractor-args", `instagram:app_id=${instagramApi}`,
		"--no-warnings",
		"--output", outTemplate,
		"--print-json",
		"--no-simulate",
	];

	// Forcing a UA while yt-dlp impersonates a browser makes the header contradict the
	// TLS fingerprint — the exact mismatch Instagram rejects. Let yt-dlp pick its own.
	if (!isInstagram) args.push("--user-agent", USER_AGENT);

	if (cookiesFile) args.push("--cookies", cookiesFile);

	return args;
}

/**
 * @param {BuildOpts} opts
 * @returns {string[]}
 */
function buildArgs(opts) {
	return [
		// Telegram's player is only dependable with H.264 video + AAC audio in MP4: AV1 and
		// VP9 play as a black screen on many clients, and Opus in MP4 plays silently. Ask for
		// avc1+mp4a first, capped by size so an oversized source degrades in resolution
		// instead of failing outright, and only fall back to looser matches.
		"--format",
		[
			`bestvideo[vcodec^=avc1][filesize_approx<${VIDEO_SIZE_CAP_MB}M]+bestaudio[acodec^=mp4a]`,
			"bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]",
			"bestvideo[ext=mp4]+bestaudio[ext=m4a]",
			"best[ext=mp4]",
			"bestvideo+bestaudio",
			"best",
		].join("/"),
		"--merge-output-format", "mp4",
		// DASH sources arrive as fragmented MP4: moof/mvex boxes and no stss keyframe index.
		// Desktop players parse the fragments, mobile decoders rely on the moov index and show
		// a frozen picture while the audio plays. Merging rewrites the container, but a single
		// video-only format is never merged, and --remux-video/--fixup both skip a file that is
		// already mp4. Embedding metadata forces the stream-copy rewrite that normalizes it.
		"--embed-metadata",
		"--postprocessor-args", "Metadata:-movflags +faststart",
		"--no-playlist",
		"--concurrent-fragments", "16",
		"--fragment-retries", "5",
		"--buffer-size", "16K",
		"--http-chunk-size", "10M",
		"--max-filesize", `${MAX_FILE_SIZE_MB}M`,
		...buildBaseArgs(opts),
	];
}

/**
 * @param {BuildOpts} opts
 * @returns {string[]}
 */
function buildImageArgs(opts) {
	// Instagram exposes photos only as thumbnails (no "images" format), and raises
	// "There is no video in this post" unless no-formats errors are ignored.
	const modeArgs = opts.isInstagram
		? ["--ignore-no-formats-error", "--skip-download", "--write-thumbnail"]
		: ["--format", "images"];
	return [...modeArgs, ...buildBaseArgs(opts)];
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

	if (/rate-limit|redirected to the login page/i.test(line))
		return _canImpersonate === false
			? "Instagram needs a yt-dlp build with browser impersonation. Ask the admin to update yt-dlp."
			: "Instagram refused anonymous access to this post. Retry later or ask the admin to configure cookies.";

	if (/not granting access/i.test(line))
		return "Instagram is not granting access to this post. Retry later or ask the admin to configure cookies.";

	if (/cookies are no longer valid/i.test(line))
		return "The configured Instagram cookies have expired. Ask the admin to refresh them.";

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
				const err = new DownloadError(extractError(stderr));
				// Tag from raw stderr, before extractError() rewrites the message
				if (AUTH_ERROR_RE.test(stderr)) err.authError = true;
				settle(reject, err);
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

	let lastErr = null;
	for (const candidate of RUNNER_CANDIDATES) {
		try {
			await spawnRunner(candidate, ["--version"]);
			_runner = candidate;
			return _runner;
		} catch (err) {
			if (err.code !== "NOT_FOUND") {
				lastErr = err;
				console.warn(`yt-dlp candidate "${candidate.cmd}" failed:`, err.message);
			}
		}
	}

	if (lastErr) {
		throw new DownloadError(`yt-dlp found but failed to run: ${lastErr.message}`);
	}
	throw new DownloadError(
		'yt-dlp not found. Run: pip install "yt-dlp[default,curl-cffi]"  OR  add the yt-dlp binary to PATH.'
	);
}

getRunner()
	.then(async (runner) => {
		const targets = await spawnRunner(runner, ["--list-impersonate-targets"]);
		_canImpersonate = /chrome|edge|safari/i.test(targets);
		if (!_canImpersonate) console.warn(IMPERSONATION_HINT);
	})
	.catch(() => {});

/** @typedef {{ type: "video", filePath: string, title: string, duration: number, uploader: string, platform: string, fileSize: number }} VideoResult */
/** @typedef {{ type: "images", imagePaths: string[], title: string, uploader: string, platform: string, count: number }} ImagesResult */

/**
 * Single download attempt — shared between video and image modes.
 * @param {string} url
 * @param {string} instagramApi
 * @param {"video"|"images"} mode
 * @returns {Promise<VideoResult|ImagesResult>}
 */
async function doDownloadMedia(url, instagramApi, mode) {
	const isVideo = mode === "video";
	const runner = await getRunner();

	const fileId = randomBytes(6).toString("hex");
	const outTemplate = join(
		DOWNLOAD_DIR,
		isVideo ? `${fileId}.%(ext)s` : `${fileId}.%(autonumber)s.%(ext)s`
	);

	const cookiesArg =
		COOKIES_FILE && (await fileExists(COOKIES_FILE)) ? COOKIES_FILE : null;

	const opts = {
		outTemplate,
		cookiesFile: cookiesArg,
		instagramApi,
		isInstagram: url.includes("instagram.com"),
	};
	const args = [...(isVideo ? buildArgs(opts) : buildImageArgs(opts)), url];

	let stdout;
	try {
		stdout = await spawnRunner(runner, args);
	} catch (err) {
		// Clean up partial files
		if (isVideo) {
			const partial = await findDownloadedFile(DOWNLOAD_DIR, fileId);
			if (partial) unlink(partial).catch(() => {});
		} else {
			const images = await findDownloadedImages(DOWNLOAD_DIR, fileId);
			for (const img of images) unlink(img).catch(() => {});
		}
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

	if (isVideo) {
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
 * Run a download, retrying Instagram with the next app_id (web → ios) on auth/rate-limit errors.
 * @param {string} url
 * @param {"video"|"images"} mode
 * @returns {Promise<VideoResult|ImagesResult>}
 */
async function downloadWithFallback(url, mode) {
	const isInstagram = url.includes("instagram.com");
	const apis = isInstagram ? INSTAGRAM_APIS : ["web"];
	let lastErr;

	for (const api of apis) {
		try {
			return await doDownloadMedia(url, api, mode);
		} catch (err) {
			lastErr = err;
			if (!isInstagram || !isAuthError(err)) throw err;
			console.warn(`Instagram app_id=${api} failed (${err.message}), trying next.`);
		}
	}
	throw lastErr;
}

/**
 * Download a video from a URL.
 * @param {string} url
 * @returns {Promise<VideoResult>}
 */
export function download(url) {
	return /** @type {Promise<VideoResult>} */ (downloadWithFallback(url, "video"));
}

/**
 * Download images (TikTok slideshow / Instagram photo post or carousel) from a URL.
 * @param {string} url
 * @returns {Promise<ImagesResult>}
 */
export function downloadImages(url) {
	return /** @type {Promise<ImagesResult>} */ (downloadWithFallback(url, "images"));
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
