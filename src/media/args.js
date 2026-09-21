import { MAX_FILE_SIZE_MB } from "../config.js";

// Headroom under MAX_FILE_SIZE_MB for the audio track and container overhead, so the
// video stream alone is picked below the cap rather than blowing the Telegram limit.
const VIDEO_SIZE_CAP_MB = Math.max(MAX_FILE_SIZE_MB - 5, 5);

const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const TIKTOK_EXTRACTOR_ARGS = "tiktok:api_hostname=api22-normal-c-useast2a.tiktokv.com";

// One line per update (instead of \r-overwrites) so the parent process can read progress
// off stdout, tagged so it can't be confused with the final --print-json document.
export const PROGRESS_PREFIX = "PROGRESS ";
const PROGRESS_ARGS = ["--newline", "--progress-template", `download:${PROGRESS_PREFIX}%(progress._percent_str)s`];

// Telegram's player is only dependable with H.264 video + AAC audio in MP4: AV1 and VP9
// play as a black screen on many clients, and Opus in MP4 plays silently. Ask for
// avc1+mp4a first, capped by size so an oversized source degrades in resolution instead
// of failing outright, and only then fall back to looser matches.
export const VIDEO_FORMAT = [
	`bestvideo[vcodec^=avc1][filesize_approx<${VIDEO_SIZE_CAP_MB}M]+bestaudio[acodec^=mp4a]`,
	"bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]",
	"bestvideo[ext=mp4]+bestaudio[ext=m4a]",
	"best[ext=mp4]",
	"bestvideo+bestaudio",
	"best",
].join("/");

/**
 * @typedef {object} BuildOpts
 * @property {string} outTemplate   yt-dlp output template
 * @property {string|null} cookiesFile
 * @property {string} instagramApi  yt-dlp `instagram:app_id` alias (web | ios)
 * @property {boolean} isInstagram
 */

/**
 * Flags shared by video and image downloads.
 * @param {BuildOpts} opts
 * @returns {string[]}
 */
function baseArgs({ outTemplate, cookiesFile, instagramApi, isInstagram }) {
	const args = [
		"--socket-timeout", "15",
		"--retries", "3",
		"--geo-bypass",
		// One --extractor-args per extractor: yt-dlp does not accept several IE keys in one value.
		"--extractor-args", TIKTOK_EXTRACTOR_ARGS,
		"--extractor-args", `instagram:app_id=${instagramApi}`,
		"--no-warnings",
		"--output", outTemplate,
		"--print-json",
		"--no-simulate",
		...PROGRESS_ARGS,
	];

	// Forcing a UA while yt-dlp impersonates a browser makes the header contradict the
	// TLS fingerprint — the exact mismatch Instagram rejects. Let yt-dlp pick its own there.
	if (!isInstagram) args.push("--user-agent", USER_AGENT);
	if (cookiesFile) args.push("--cookies", cookiesFile);

	return args;
}

/**
 * @param {BuildOpts} opts
 * @returns {string[]}
 */
export function buildVideoArgs(opts) {
	return [
		"--format", VIDEO_FORMAT,
		"--merge-output-format", "mp4",
		// The merger already stream-copies; scoping the flag to it keeps every other
		// postprocessor's own options intact.
		"--postprocessor-args", "Merger:-movflags +faststart",
		"--no-playlist",
		"--concurrent-fragments", "16",
		"--fragment-retries", "5",
		"--buffer-size", "16K",
		"--http-chunk-size", "10M",
		"--max-filesize", `${MAX_FILE_SIZE_MB}M`,
		...baseArgs(opts),
	];
}

/**
 * @param {BuildOpts} opts
 * @returns {string[]}
 */
export function buildImageArgs(opts) {
	// Instagram exposes photos only as thumbnails (no "images" format) and raises
	// "There is no video in this post" unless no-formats errors are ignored.
	const modeArgs = opts.isInstagram
		? ["--ignore-no-formats-error", "--skip-download", "--write-thumbnail"]
		: ["--format", "images"];
	return [...modeArgs, ...baseArgs(opts)];
}
