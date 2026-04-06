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

const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const RUNNER_CANDIDATES = [
	{ cmd: "yt-dlp",  pre: [] },
	{ cmd: "python",  pre: ["-m", "yt_dlp"] },
	{ cmd: "python3", pre: ["-m", "yt_dlp"] },
	{ cmd: "py",      pre: ["-m", "yt_dlp"] },
];

let _runner = null;

function buildArgs(outTemplate, cookiesFile) {
	const args = [
		"--format",
		[
			"bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]",
			"bestvideo[ext=mp4]+bestaudio[ext=m4a]",
			"best[ext=mp4]",
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
		"--geo-bypass",
		"--user-agent", USER_AGENT,
		"--extractor-args", "tiktok:api_hostname=api22-normal-c-useast2a.tiktokv.com",
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

function buildImageArgs(outTemplate, cookiesFile) {
	const args = [
		"--no-playlist",
		"--socket-timeout", "15",
		"--retries", "3",
		"--geo-bypass",
		"--user-agent", USER_AGENT,
		"--extractor-args", "tiktok:api_hostname=api22-normal-c-useast2a.tiktokv.com",
		"--no-warnings",
		"--write-thumbnail",
		"--convert-thumbnails", "jpg",
		"--skip-download",
		"--output", outTemplate,
		"--print-json",
		"--no-simulate",
	];

	if (cookiesFile) {
		args.push("--cookies", cookiesFile);
	}

	return args;
}

async function fileExists(p) {
	try { await access(p, fsConstants.F_OK); return true; } catch { return false; }
}

async function findDownloadedFile(dir, prefix) {
	const mp4 = join(dir, `${prefix}.mp4`);
	if (await fileExists(mp4)) return mp4;

	const files = (await readdir(dir)).filter((f) => f.startsWith(prefix));
	if (!files.length) return null;

	const preferred = files.find((f) => f.endsWith(".mp4")) ?? files[0];
	return join(dir, preferred);
}

async function findDownloadedImages(dir, prefix) {
	const files = await readdir(dir);
	return files
		.filter((f) => {
			if (!f.startsWith(prefix)) return false;
			const ext = f.slice(f.lastIndexOf(".")).toLowerCase();
			return IMAGE_EXTS.has(ext);
		})
		.sort()
		.map((f) => join(dir, f));
}

function extractError(raw) {
	let line = raw
		.split(/\r?\n/)
		.find((l) => l.includes("ERROR:"))
		?.replace(/^.*ERROR:\s*/, "")
		.trim();

	if (!line) return "Download failed — the link may be private or unsupported.";

	line = line.replace(/\s*;\s*please report this issue.*/i, "").trim();
	line = line.replace(/\s*Confirm you are on the latest version.*/i, "").trim();
	line = line.replace(/\s*Use\s+--cookies[^.]*/gi, "").trim();

	if (/Unable to extract webpage video data/i.test(line))
		return "TikTok extraction failed. Try another URL or retry later.";
	if (/(sign\s*in|login|authentication|confirm.*not.*bot)/i.test(line))
		return "This content requires authentication on the source platform.";

	return line || "Download failed — the link may be private or unsupported.";
}

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

getRunner().catch(() => { });

export async function download(url) {
	const runner = await getRunner();

	const fileId = randomBytes(6).toString("hex");
	const outTemplate = join(DOWNLOAD_DIR, `${fileId}.%(ext)s`);

	const cookiesArg =
		COOKIES_FILE && (await fileExists(COOKIES_FILE)) ? COOKIES_FILE : null;

	const args = [...buildArgs(outTemplate, cookiesArg), url];

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

export async function downloadImages(url) {
	const runner = await getRunner();

	const fileId = randomBytes(6).toString("hex");
	const outTemplate = join(DOWNLOAD_DIR, `${fileId}.%(autonumber)s.%(ext)s`);

	const cookiesArg =
		COOKIES_FILE && (await fileExists(COOKIES_FILE)) ? COOKIES_FILE : null;

	const args = [...buildImageArgs(outTemplate, cookiesArg), url];

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

export async function cleanupImages(imagePaths) {
	await Promise.all(imagePaths.map((p) => unlink(p).catch(() => {})));
}

export async function cleanup(filePath) {
	if (filePath) await unlink(filePath).catch(() => {});
}
