import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";

const { buildVideoArgs, buildImageArgs, VIDEO_FORMAT } = await import("../src/media/args.js");

const base = { outTemplate: "/tmp/x.%(ext)s", cookiesFile: null, instagramApi: "web", isInstagram: false };

/** Values following every occurrence of a flag. */
const valuesOf = (args, flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

test("video format ladder asks for H.264 + AAC first and keeps a generic fallback", () => {
	const ladder = VIDEO_FORMAT.split("/");
	assert.match(ladder[0], /^bestvideo\[vcodec\^=avc1\]\[filesize_approx<\d+M\]\+bestaudio\[acodec\^=mp4a\]$/);
	assert.equal(ladder.at(-1), "best");
});

test("video args merge to mp4 and scope faststart to the merger only", () => {
	const args = buildVideoArgs(base);
	assert.deepEqual(valuesOf(args, "--merge-output-format"), ["mp4"]);
	assert.deepEqual(valuesOf(args, "--postprocessor-args"), ["Merger:-movflags +faststart"]);
	assert.ok(args.includes("--no-playlist"));
});

test("extractor args are passed one per extractor, with the real Instagram app_id key", () => {
	const args = buildVideoArgs({ ...base, instagramApi: "ios" });
	assert.deepEqual(valuesOf(args, "--extractor-args"), [
		"tiktok:api_hostname=api22-normal-c-useast2a.tiktokv.com",
		"instagram:app_id=ios",
	]);
});

test("a forced user agent is dropped for Instagram so it cannot contradict impersonation", () => {
	assert.ok(buildVideoArgs(base).includes("--user-agent"));
	assert.ok(!buildVideoArgs({ ...base, isInstagram: true }).includes("--user-agent"));
});

test("cookies are only passed when a file is configured", () => {
	assert.deepEqual(valuesOf(buildVideoArgs(base), "--cookies"), []);
	assert.deepEqual(valuesOf(buildVideoArgs({ ...base, cookiesFile: "/c.txt" }), "--cookies"), ["/c.txt"]);
});

test("image mode uses the images format on TikTok and thumbnails on Instagram", () => {
	assert.deepEqual(valuesOf(buildImageArgs(base), "--format"), ["images"]);

	const ig = buildImageArgs({ ...base, isInstagram: true });
	assert.deepEqual(valuesOf(ig, "--format"), []);
	for (const flag of ["--ignore-no-formats-error", "--skip-download", "--write-thumbnail"]) {
		assert.ok(ig.includes(flag), `missing ${flag}`);
	}
	assert.ok(!ig.includes("--no-playlist"), "carousels must not be truncated to one entry");
});
