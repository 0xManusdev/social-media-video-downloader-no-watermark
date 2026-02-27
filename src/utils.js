import { PLATFORMS } from "./config.js";

// ── URL extraction ───────────────────────────────────────────────
const URL_RE = /https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b[-a-zA-Z0-9()@:%_+.~#?&/=]*/gi;

export function extractUrls(text) {
  return [...new Set(text.match(URL_RE) || [])].map(normalizeUrl);
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    // Strip tracking params from TikTok
    if (u.hostname.includes("tiktok.com")) {
      return `${u.origin}${u.pathname}`;
    }
    return url;
  } catch {
    return url;
  }
}

// ── Platform detection ───────────────────────────────────────────
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

// ── File size formatting ─────────────────────────────────────────
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

// ── HTML escaping ────────────────────────────────────────────────
export function escapeHtml(text = "") {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
