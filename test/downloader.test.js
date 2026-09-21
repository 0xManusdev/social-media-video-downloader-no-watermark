import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "fs";
import { writeFile } from "fs/promises";
import { join } from "path";

import { DOWNLOAD_DIR } from "../src/config.js";
import { DownloadError } from "../src/media/errors.js";

// Grab the real isAuthError before any test mocks ytdlp.js, so the fallback tests exercise
// the actual auth-detection logic instead of a hand-rolled stand-in.
const { isAuthError: realIsAuthError } = await import("../src/media/ytdlp.js");

/** The 12 hex chars randomBytes(6) produces, read back out of the --output template. */
function fileIdFromArgs(args) {
	const out = args[args.indexOf("--output") + 1];
	const base = out.split(/[\\/]/).pop();
	return base.match(/^([0-9a-f]{12})\./)[1];
}

function instagramApiFromArgs(args) {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--extractor-args" && args[i + 1]?.startsWith("instagram:app_id=")) {
			return args[i + 1].split("=")[1];
		}
	}
	return null;
}

function isImageModeArgs(args) {
	return args[args.indexOf("--format") + 1] === "images";
}

const infoJson = (extra = {}) => JSON.stringify({ title: "t", extractor_key: "X", uploader: "u", ...extra });

async function stageVideo(fileId) {
	await writeFile(join(DOWNLOAD_DIR, `${fileId}.mp4`), "not a real video");
}
async function stageImages(fileId, count) {
	for (let i = 1; i <= count; i++) await writeFile(join(DOWNLOAD_DIR, `${fileId}.${i}.jpg`), "not a real image");
}

/** Re-imports downloader.js fresh, wired to a mocked ytdlp.js for this test only. */
async function importDownloader(t, { run, isAuthError = realIsAuthError }) {
	t.mock.module("../src/media/ytdlp.js", { exports: { runYtDlp: run, isAuthError } });
	return import(`../src/media/downloader.js?case=${Math.random()}`);
}

test("a successful attempt returns a VideoResult backed by a real file, which cleanup removes", async (t) => {
	const run = async (args) => {
		await stageVideo(fileIdFromArgs(args));
		return infoJson({ title: "My Video", uploader: "alice", duration: 12 });
	};
	const { download, cleanupResult } = await importDownloader(t, { run });

	const result = await download("https://www.tiktok.com/@x/video/123");
	assert.equal(result.type, "video");
	assert.equal(result.title, "My Video");
	assert.equal(result.uploader, "alice");
	assert.ok(existsSync(result.filePath));

	await cleanupResult(result);
	assert.ok(!existsSync(result.filePath));
});

test("a non-auth video failure on an image-fallback platform retries as an image download", async (t) => {
	let calls = 0;
	const run = async (args) => {
		calls++;
		if (!isImageModeArgs(args)) throw new DownloadError("There is no video in this post");
		await stageImages(fileIdFromArgs(args), 2);
		return infoJson({ title: "Gallery" });
	};
	const { fetchMedia, cleanupResult } = await importDownloader(t, { run });

	let fellBack = false;
	const result = await fetchMedia("https://www.tiktok.com/@x/photo/123", {
		imageFallback: true,
		onImageFallback: () => { fellBack = true; },
	});

	assert.equal(fellBack, true);
	assert.equal(result.type, "images");
	assert.equal(result.count, 2);
	assert.equal(calls, 2, "one video attempt, then one image attempt");

	await cleanupResult(result);
});

test("an auth-flagged failure is surfaced directly, never retried as an image download", async (t) => {
	const run = async () => {
		throw new DownloadError("Instagram is not granting access to this post.", { authError: true });
	};
	const { fetchMedia } = await importDownloader(t, { run });

	let fallbackCalled = false;
	await assert.rejects(
		() =>
			fetchMedia("https://www.instagram.com/p/abc/", {
				imageFallback: true,
				onImageFallback: () => { fallbackCalled = true; },
			}),
		/not granting access/
	);
	assert.equal(fallbackCalled, false);
});

test("Instagram retries with the ios app_id after the web app_id hits an auth error", async (t) => {
	const run = async (args) => {
		const api = instagramApiFromArgs(args);
		if (api === "web") throw new DownloadError("rate-limit for accessing posts anonymously", { authError: true });
		await stageVideo(fileIdFromArgs(args));
		return infoJson({ title: "Reel" });
	};
	const { download, cleanupResult } = await importDownloader(t, { run });

	const result = await download("https://www.instagram.com/reel/abc/");
	assert.equal(result.title, "Reel");

	await cleanupResult(result);
});

test("Instagram gives up after both app_ids fail with an auth error", async (t) => {
	let calls = 0;
	const run = async () => {
		calls++;
		throw new DownloadError("login required", { authError: true });
	};
	const { download } = await importDownloader(t, { run });

	await assert.rejects(() => download("https://www.instagram.com/p/xyz/"), /login required/);
	assert.equal(calls, 2, "both web and ios app_ids were tried");
});
