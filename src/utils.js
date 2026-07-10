import { PLATFORMS } from "./config.js";

const URL_RE = /https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b[-a-zA-Z0-9()@:%_+.~#?&/=]*/gi;

/** Tracking / analytics params to strip from URLs */
const TRACKING_PARAMS = new Set([
	"utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
	"fbclid", "gclid", "gclsrc", "dclid", "gbraid", "wbraid",
	"msclkid", "twclid", "sc_campaign", "sc_channel", "sc_content",
	"sc_medium", "sc_outcome", "sc_geo", "sc_country",
	"ref", "source", "si", "s_kwcid",
]);

/**
 * Extract unique URLs from text, deduplicated and normalized.
 * @param {string} text
 * @returns {string[]}
 */
export function extractUrls(text) {
	return [...new Set(text.match(URL_RE) || [])].map(normalizeUrl);
}

/**
 * Check if an Instagram URL points to a post (gallery-capable).
 * Reels (/reel/) are videos, not galleries.
 * @param {string} url
 * @returns {boolean}
 */
export function isInstagramGallery(url) {
	try {
		const u = new URL(url);
		if (!u.hostname.includes("instagram.com")) return false;
		return /\/(p|tv)\//.test(u.pathname);
	} catch {
		return false;
	}
}

/**
 * Remove tracking parameters from a URL.
 * @param {string} url
 * @returns {string}
 */
function stripTrackingParams(url) {
	try {
		const u = new URL(url);
		let changed = false;
		for (const key of [...u.searchParams.keys()]) {
			if (TRACKING_PARAMS.has(key)) {
				u.searchParams.delete(key);
				changed = true;
			}
		}
		return changed ? u.toString() : url;
	} catch {
		return url;
	}
}

/**
 * Normalize a URL for yt-dlp: rewrite TikTok /photo/ → /video/, strip tracking.
 * @param {string} url
 * @returns {string}
 */
function normalizeUrl(url) {
	url = stripTrackingParams(url);
	try {
		const u = new URL(url);
		if (u.hostname.includes("tiktok.com")) {
			const pathname = u.pathname.replace(/\/photo\//, "/video/");
			return `${u.origin}${pathname}${u.search}`;
		}
		return url;
	} catch {
		return url;
	}
}

/**
 * Identify the platform for a given URL.
 * @param {string} url
 * @returns {string|null}
 */
export function identifyPlatform(url) {
	try {
		const hostname = new URL(url).hostname.replace(/^www\./, "");
		for (const [name, domains] of Object.entries(PLATFORMS)) {
			if (domains.some((d) => hostname === d || hostname.endsWith(`.${d}`))) {
				return name;
			}
		}
	} catch {}
	return null;
}

/**
 * Format a byte count into a human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

/**
 * Escape text for use in Telegram HTML parse mode.
 * @param {string} [text]
 * @returns {string}
 */
export function escapeHtml(text = "") {
	return String(text)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
