import { spawn } from "child_process";
import { MAX_FILE_SIZE_BYTES } from "../config.js";
import { DownloadError } from "./errors.js";
import { PROGRESS_PREFIX } from "./args.js";

// Timeout scales with the size cap (assume a slow link) instead of being a fixed constant.
const MIN_THROUGHPUT_BYTES_PER_SEC = 300 * 1024;
const BASE_TIMEOUT_MS = 60_000;
const ENV_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS);
export const TIMEOUT_MS =
	ENV_TIMEOUT_MS > 0
		? ENV_TIMEOUT_MS
		: BASE_TIMEOUT_MS + Math.ceil((MAX_FILE_SIZE_BYTES / MIN_THROUGHPUT_BYTES_PER_SEC) * 1000);

/** @type {{ cmd: string, pre: string[] }[]} */
const RUNNER_CANDIDATES = [
	{ cmd: "yt-dlp",  pre: [] },
	{ cmd: "python",  pre: ["-m", "yt_dlp"] },
	{ cmd: "python3", pre: ["-m", "yt_dlp"] },
	{ cmd: "py",      pre: ["-m", "yt_dlp"] },
];

const INSTALL_HINT = 'pip install "yt-dlp[default,curl-cffi]"';

// yt-dlp needs curl_cffi to impersonate a browser's TLS fingerprint. Without it Instagram
// redirects every anonymous post to its login page, which yt-dlp reports as a rate-limit.
const IMPERSONATION_HINT =
	"yt-dlp has no browser impersonation (curl_cffi missing) — Instagram downloads will fail. " +
	`Use a build that bundles it (yt-dlp_linux) or run: ${INSTALL_HINT}`;

export const AUTH_ERROR_RE =
	/(empty media response|sign\s*in|login|logged\s*in|authentication|rate-limit|not granting access|cookies are no longer valid)/i;

/** @type {{ cmd: string, pre: string[] } | null} */
let runner = null;
/** @type {boolean|null} null until warmUp() has probed */
let canImpersonate = null;

/**
 * True when the failure is an auth / rate-limit / access problem on the source platform,
 * i.e. retrying with the same credentials or a different mode is pointless.
 * @param {unknown} err
 */
export function isAuthError(err) {
	return Boolean(err?.authError) || AUTH_ERROR_RE.test(err?.message || "");
}

/**
 * Turn yt-dlp stderr into a message fit for the chat.
 * @param {string} raw
 * @returns {string}
 */
export function extractError(raw) {
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
		return canImpersonate === false
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
 * @param {{ cmd: string, pre: string[] }} candidate
 * @param {string[]} args
 * @param {{ onProgress?: (percent: string) => void }} [opts]
 * @returns {Promise<string>} stdout
 */
function spawnProcess({ cmd, pre }, args, { onProgress } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, [...pre, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		let stdout = "";
		let stderr = "";
		let lineBuf = "";
		let timedOut = false;
		let settled = false;

		const settle = (fn, val) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (!child.killed) try { child.kill("SIGTERM"); } catch {}
			fn(val);
		};

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, TIMEOUT_MS);

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (c) => {
			stdout += c;
			if (!onProgress) return;
			// --newline guarantees one update per line; buffer the trailing partial line.
			lineBuf += c;
			const lines = lineBuf.split("\n");
			lineBuf = lines.pop();
			for (const line of lines) {
				if (line.startsWith(PROGRESS_PREFIX)) onProgress(line.slice(PROGRESS_PREFIX.length).trim());
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (c) => { stderr += c; });

		child.on("error", (err) => {
			if (err.code === "ENOENT") {
				settle(reject, new DownloadError(`${cmd}: binary not found.`, { code: "NOT_FOUND" }));
			} else {
				settle(reject, new DownloadError(`Failed to launch ${cmd}: ${err.message}`));
			}
		});

		child.on("close", (code) => {
			if (timedOut) {
				settle(reject, new DownloadError(`Download timed out after ${TIMEOUT_MS / 1000}s.`));
				return;
			}
			if (code !== 0) {
				if (/No module named yt_dlp/i.test(stderr)) {
					settle(reject, new DownloadError(`${cmd}: yt_dlp module missing.`, { code: "NOT_FOUND" }));
					return;
				}
				console.warn("yt-dlp stderr:\n", stderr);
				const err = new DownloadError(extractError(stderr), { authError: AUTH_ERROR_RE.test(stderr) });
				err.stderr = stderr;
				settle(reject, err);
				return;
			}
			settle(resolve, stdout);
		});
	});
}

async function getRunner() {
	if (runner) return runner;

	// A missing interpreter is not always ENOENT (the Windows Store "python" alias exits 9009
	// with a message), so report what each candidate actually said instead of guessing why.
	const failures = [];
	for (const candidate of RUNNER_CANDIDATES) {
		try {
			await spawnProcess(candidate, ["--version"]);
			runner = candidate;
			return runner;
		} catch (err) {
			const detail =
				err.code === "NOT_FOUND"
					? "not found"
					: err.stderr?.trim().split(/\r?\n/).find(Boolean) || err.message;
			failures.push(`${candidate.cmd}: ${detail}`);
		}
	}

	throw new DownloadError(
		`yt-dlp is not available. Run: ${INSTALL_HINT}  OR  add the yt-dlp binary to PATH. ` +
		`Tried — ${failures.join("; ")}`
	);
}

/**
 * Run yt-dlp with the given arguments and return its stdout.
 * @param {string[]} args
 * @param {{ onProgress?: (percent: string) => void }} [opts]
 * @returns {Promise<string>}
 */
export async function runYtDlp(args, opts) {
	return spawnProcess(await getRunner(), args, opts);
}

/**
 * Locate yt-dlp and probe browser impersonation support once at startup, so the
 * missing-curl_cffi case is logged loudly instead of surfacing as a bogus rate-limit.
 * @returns {Promise<{ command: string, canImpersonate: boolean }>}
 */
export async function warmUp() {
	const r = await getRunner();
	const targets = await spawnProcess(r, ["--list-impersonate-targets"]);
	canImpersonate = /chrome|edge|safari/i.test(targets);
	if (!canImpersonate) console.warn(IMPERSONATION_HINT);
	return { command: r.cmd, canImpersonate };
}
