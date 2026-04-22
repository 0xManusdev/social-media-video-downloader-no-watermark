import { PLATFORMS } from "./config.js";

const URL_RE = /https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b[-a-zA-Z0-9()@:%_+.~#?&/=]*/gi;

export function extractUrls(text) {
  return [...new Set(text.match(URL_RE) || [])].map(normalizeUrl);
}

export function isTikTokPhoto(url) {
	try {
		const u = new URL(url);
		return u.hostname.includes("tiktok.com") && /\/photo\//.test(u.pathname);
	} catch {
		return false;
	}
}

export function isInstagramGallery(url) {
	try {
		const u = new URL(url);
		if (!u.hostname.includes("instagram.com")) return false;
		return /\/(p|tv)\//.test(u.pathname);
	} catch {
		return false;
	}
}

function normalizeUrl(url) {
	try {
		const u = new URL(url);
    if (u.hostname.includes("tiktok.com")) {
      // yt-dlp's TikTok extractor only matches /video/ paths — rewrite /photo/ so it's recognized
      const pathname = u.pathname.replace(/\/photo\//, "/video/");
      return `${u.origin}${pathname}`;
    }
    return url;
  } catch {
    return url;
  }
}

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

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function escapeHtml(text = "") {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
