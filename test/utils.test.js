import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";

const { extractUrls, identifyPlatform, escapeHtml, formatBytes } = await import("../src/utils.js");

test("extractUrls dedupes and strips tracking parameters", () => {
	const text = [
		"look https://www.instagram.com/reel/abc123/?utm_source=ig&igsh=keep",
		"again https://www.instagram.com/reel/abc123/?utm_source=ig&igsh=keep",
	].join("\n");
	assert.deepEqual(extractUrls(text), ["https://www.instagram.com/reel/abc123/?igsh=keep"]);
});

test("extractUrls rewrites TikTok photo links to the video route yt-dlp understands", () => {
	assert.deepEqual(
		extractUrls("https://www.tiktok.com/@user/photo/7300000000000000000"),
		["https://www.tiktok.com/@user/video/7300000000000000000"]
	);
});

test("extractUrls returns nothing for plain text", () => {
	assert.deepEqual(extractUrls("hello there"), []);
});

test("identifyPlatform matches registered domains and their subdomains only", () => {
	assert.equal(identifyPlatform("https://vm.tiktok.com/ZMabc/"), "TikTok");
	assert.equal(identifyPlatform("https://www.instagram.com/p/x/"), "Instagram");
	assert.equal(identifyPlatform("https://youtu.be/dQw4w9WgXcQ"), "YouTube");
	assert.equal(identifyPlatform("https://x.com/user/status/1"), "X (Twitter)");
	assert.equal(identifyPlatform("https://notinstagram.com/p/x/"), null);
	assert.equal(identifyPlatform("not a url"), null);
});

test("escapeHtml neutralizes the characters Telegram HTML mode interprets", () => {
	assert.equal(escapeHtml("<b>a & b</b>"), "&lt;b&gt;a &amp; b&lt;/b&gt;");
	assert.equal(escapeHtml(), "");
});

test("formatBytes picks a human unit", () => {
	assert.equal(formatBytes(512), "512 B");
	assert.equal(formatBytes(2048), "2.0 KB");
	assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
});
