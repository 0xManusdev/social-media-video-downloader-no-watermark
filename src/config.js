import "dotenv/config";
import { existsSync, mkdirSync } from "fs";

export const BOT_TOKEN = process.env.BOT_TOKEN || "";
if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing from .env");

export const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter(Number.isFinite);

export const COOKIES_FILE = process.env.COOKIES_FILE || "";

export const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || "50", 10);
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

export const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || "./downloads";
if (!existsSync(DOWNLOAD_DIR)) mkdirSync(DOWNLOAD_DIR, { recursive: true });

export const COOLDOWN_SECONDS = parseInt(process.env.COOLDOWN_SECONDS || "5", 10);
export const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || "3", 10);

export const PLATFORMS = {
  TikTok:      ["tiktok.com", "vm.tiktok.com", "vt.tiktok.com"],
  Instagram:   ["instagram.com"],
  Facebook:    ["facebook.com", "fb.watch", "fb.com"],
  Pinterest:   ["pinterest.com", "pin.it"],
  "X (Twitter)": ["twitter.com", "x.com"],
  YouTube:     ["youtube.com", "youtu.be", "m.youtube.com"],
  Reddit:      ["reddit.com", "redd.it", "v.redd.it"],
  Snapchat:    ["snapchat.com", "t.snapchat.com"],
  Threads:     ["threads.net"],
};
