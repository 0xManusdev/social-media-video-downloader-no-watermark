import { execFile } from "child_process";
import { promisify } from "util";
import { statSync, readdirSync, unlinkSync } from "fs";
import { join, extname } from "path";
import { randomBytes } from "crypto";

import { DOWNLOAD_DIR, MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_MB } from "./config.js";

const execFileAsync = promisify(execFile);

export class DownloadError extends Error {}
export class FileTooLargeError extends Error {}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Download a video/audio using yt-dlp.
 * Returns { filePath, title, duration, uploader, platform }
 */
export async function download(url, { audioOnly = false } = {}) {
  const fileId = randomBytes(6).toString("hex");
  const outTemplate = join(DOWNLOAD_DIR, `${fileId}.%(ext)s`);

  const args = [
    "--no-playlist",
    "--socket-timeout", "30",
    "--retries", "10",
    "--fragment-retries", "10",
    "--geo-bypass",
    "--user-agent", USER_AGENT,
    "--output", outTemplate,
    "--print-json",          // print JSON info to stdout after download
    "--no-simulate",
  ];

  if (audioOnly) {
    args.push("--format", "bestaudio/best");
    args.push("--extract-audio");
    args.push("--audio-format", "mp3");
    args.push("--audio-quality", "192K");
  } else {
    args.push("--format", "bestvideo+bestaudio/best");
    args.push("--merge-output-format", "mp4");
  }

  args.push(url);

  let stdout;
  try {
    ({ stdout } = await execFileAsync("yt-dlp", args, {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024, // 10 MB stdout buffer
    }));
  } catch (err) {
    const msg = err.stderr || err.message || String(err);
    throw new DownloadError(
      msg.split("\n").find((l) => l.includes("ERROR:"))?.replace(/^.*ERROR:\s*/, "") ||
        "Download failed"
    );
  }

  // Parse info from last JSON line (yt-dlp --print-json outputs one JSON per entry)
  let info = {};
  try {
    const lastLine = stdout.trim().split("\n").pop();
    info = JSON.parse(lastLine);
  } catch {
    // non-fatal, info will just be empty
  }

  // Find the actual downloaded file
  const filePath = findFile(DOWNLOAD_DIR, fileId, audioOnly ? "mp3" : "mp4");
  if (!filePath) throw new DownloadError("File not found after download");

  // Size check
  const { size } = statSync(filePath);
  if (size > MAX_FILE_SIZE_BYTES) {
    cleanup(filePath);
    throw new FileTooLargeError(
      `File is ${(size / 1024 / 1024).toFixed(1)} MB, exceeds the ${MAX_FILE_SIZE_MB} MB Telegram limit`
    );
  }

  return {
    filePath,
    title: info.title || "Video",
    duration: info.duration || 0,
    uploader: info.uploader || info.channel || "Unknown",
    platform: info.extractor_key || "Unknown",
    fileSize: size,
  };
}

function findFile(dir, prefix, preferredExt) {
  const files = readdirSync(dir).filter((f) => f.startsWith(prefix));
  if (!files.length) return null;
  // Prefer the expected extension
  const preferred = files.find((f) => f.endsWith(`.${preferredExt}`));
  return join(dir, preferred || files[0]);
}

export function cleanup(filePath) {
  try { unlinkSync(filePath); } catch {}
}
