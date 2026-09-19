import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";

const { extractError, isAuthError } = await import("../src/media/ytdlp.js");
const { DownloadError } = await import("../src/media/errors.js");

test("extractError keeps the first ERROR line and drops yt-dlp's boilerplate", () => {
	const raw = [
		"WARNING: something minor",
		"ERROR: [Instagram] abc: Instagram sent an empty media response. Check if this post is accessible in your browser without being logged-in. If it is not, then use --cookies. Otherwise, if the post is accessible in browser without being logged-in, please report this issue on https://github.com/x , filling out the appropriate issue template. Confirm you are on the latest version using yt-dlp -U",
	].join("\n");
	assert.match(extractError(raw), /Instagram returned no data/);
});

test("extractError maps the login redirect to an actionable message", () => {
	const raw = "ERROR: [Instagram] abc: The webpage request was redirected to the login page. You have exceeded the rate-limit for accessing posts anonymously";
	assert.match(extractError(raw), /Instagram (refused anonymous access|needs a yt-dlp build)/);
});

test("extractError falls back to a generic message when there is no ERROR line", () => {
	assert.match(extractError("just some noise"), /Download failed/);
});

test("extractError passes unknown errors through, minus the bug-report tail", () => {
	const raw = "ERROR: [TikTok] 123: Video not available; please report this issue on https://example";
	assert.equal(extractError(raw), "[TikTok] 123: Video not available");
});

test("isAuthError honours the flag set from raw stderr and the message as a fallback", () => {
	assert.equal(isAuthError(new DownloadError("x", { authError: true })), true);
	assert.equal(isAuthError(new Error("You have exceeded the rate-limit for accessing posts anonymously")), true);
	assert.equal(isAuthError(new Error("There is no video in this post")), false);
	assert.equal(isAuthError(undefined), false);
});
