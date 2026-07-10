import "dotenv/config";
import { existsSync, mkdirSync } from "fs";

function requireEnv(name) {
	const val = process.env[name];
	if (!val) throw new Error(`${name} is missing from .env`);
	return val;
}

function intEnv(name, fallback) {
	const val = parseInt(process.env[name], 10);
	return Number.isFinite(val) ? val : fallback;
}

/** @type {string} */
export const BOT_TOKEN = requireEnv("BOT_TOKEN");

/** @type {number[]} */
export const ADMIN_IDS = (process.env.ADMIN_IDS || "")
	.split(",")
	.map((s) => parseInt(s.trim(), 10))
	.filter(Number.isFinite);

/** @type {string} */
export const COOKIES_FILE = process.env.COOKIES_FILE || "";

/** @type {number} */
export const MAX_FILE_SIZE_MB = intEnv("MAX_FILE_SIZE_MB", 50);
/** @type {number} */
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

/** @type {string} */
export const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || "./downloads";
if (!existsSync(DOWNLOAD_DIR)) mkdirSync(DOWNLOAD_DIR, { recursive: true });

/** @type {number} */
export const COOLDOWN_SECONDS = intEnv("COOLDOWN_SECONDS", 5);
/** @type {number} */
export const MAX_CONCURRENT = intEnv("MAX_CONCURRENT_DOWNLOADS", 3);

/** @type {Record<string, string[]>} */
export const PLATFORMS = {
	TikTok:        ["tiktok.com", "vm.tiktok.com", "vt.tiktok.com"],
	Instagram:     ["instagram.com"],
	Facebook:      ["facebook.com", "fb.watch", "fb.com"],
	Pinterest:     ["pinterest.com", "pin.it"],
	"X (Twitter)": ["twitter.com", "x.com"],
	YouTube:       ["youtube.com", "youtu.be", "m.youtube.com"],
	Reddit:        ["reddit.com", "redd.it", "v.redd.it"],
	Snapchat:      ["snapchat.com", "t.snapchat.com"],
	Threads:       ["threads.net"],
};
