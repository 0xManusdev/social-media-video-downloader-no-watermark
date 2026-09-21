import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";

// MIN_FREE_BYTES is 2x MAX_FILE_SIZE_MB; setting it absurdly high makes the guard fail
// deterministically against any real disk's free space, with no mocking of the filesystem.
process.env.MAX_FILE_SIZE_MB = "100000000"; // 100 PB

test("fetchMedia refuses to start when the disk doesn't have enough free space", async (t) => {
	let ytdlpCalled = false;
	t.mock.module("../src/media/ytdlp.js", {
		exports: {
			runYtDlp: async () => { ytdlpCalled = true; return "{}"; },
			isAuthError: () => false,
		},
	});
	const { fetchMedia } = await import("../src/media/downloader.js");

	await assert.rejects(() => fetchMedia("https://www.youtube.com/watch?v=abc"), /disk space/i);
	assert.equal(ytdlpCalled, false, "yt-dlp must never be spawned once the guard rejects");
});
