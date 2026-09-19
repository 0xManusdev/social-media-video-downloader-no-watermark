import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, copyFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const { planNormalization, ensurePlayable, probeCodecs } = await import("../src/media/mp4.js");

const has = (bin) => !spawnSync(bin, ["-version"], { stdio: "ignore" }).error;
// These exercise the real encoder; without ffmpeg there is nothing meaningful to assert.
const skip = has("ffmpeg") && has("ffprobe") ? false : "requires ffmpeg and ffprobe on PATH";

let dir;
test.before(async () => { dir = await mkdtemp(join(tmpdir(), "normalize-test-")); });
test.after(async () => { await rm(dir, { recursive: true, force: true }); });

/** Encode a tiny clip with the given codecs. */
function encode(name, vcodec, acodec, extra = []) {
	const out = join(dir, name);
	const r = spawnSync("ffmpeg", [
		"-y", "-v", "error",
		"-f", "lavfi", "-i", "testsrc2=size=160x120:rate=15:duration=0.4",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=0.4",
		"-c:v", vcodec, "-c:a", acodec, ...extra,
		"-movflags", "+faststart", out,
	]);
	assert.equal(r.status, 0, `ffmpeg failed for ${name}: ${r.stderr}`);
	return out;
}

test("H.264 + AAC with moov first needs no work", { skip }, async () => {
	const file = encode("ok.mp4", "libx264", "aac", ["-preset", "ultrafast"]);
	const plan = await planNormalization(file);
	assert.equal(plan.action, "none");
	assert.deepEqual(await probeCodecs(file), { video: "h264", audio: "aac" });
});

test("moov written after mdat is repaired by a stream copy, not a re-encode", { skip }, async () => {
	const file = encode("slow.mp4", "libx264", "aac", ["-preset", "ultrafast", "-movflags", "+empty_moov"]);
	const plan = await planNormalization(file);
	assert.equal(plan.action, "remux");
	assert.equal((await ensurePlayable(file)).action, "remux");
	assert.equal((await planNormalization(file)).action, "none");
});

test("a codec phones cannot decode in hardware is re-encoded to H.264/AAC", { skip }, async () => {
	const file = encode("vp9.mp4", "libvpx-vp9", "libopus", ["-b:v", "80k"]);

	const plan = await planNormalization(file);
	assert.equal(plan.action, "transcode");
	assert.match(plan.reason, /vp9/);

	assert.equal((await ensurePlayable(file)).action, "transcode");
	assert.deepEqual(await probeCodecs(file), { video: "h264", audio: "aac" });
	// Re-encoded output must itself be streamable, or we would have traded one bug for another.
	assert.equal((await planNormalization(file)).action, "none");
});

test("Opus audio alone also forces a re-encode", { skip }, async () => {
	const file = encode("opus.mp4", "libx264", "libopus", ["-preset", "ultrafast"]);
	const plan = await planNormalization(file);
	assert.equal(plan.action, "transcode");
	assert.match(plan.reason, /opus/);
});

test("a silent video keeps its missing audio track instead of gaining one", { skip }, async () => {
	const src = encode("src.mp4", "libx264", "aac", ["-preset", "ultrafast"]);
	const file = join(dir, "silent.mp4");
	await copyFile(src, file);
	const r = spawnSync("ffmpeg", ["-y", "-v", "error", "-i", src, "-an", "-c:v", "copy", "-movflags", "+faststart", file]);
	assert.equal(r.status, 0);

	assert.deepEqual(await probeCodecs(file), { video: "h264", audio: null });
	assert.equal((await planNormalization(file)).action, "none");
});
