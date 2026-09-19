import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const { inspectMp4 } = await import("../src/media/mp4.js");

/** Minimal ISO-BMFF box: 32-bit size, 4-char type, payload. */
function box(type, payload = Buffer.alloc(0)) {
	const header = Buffer.alloc(8);
	header.writeUInt32BE(8 + payload.length, 0);
	header.write(type, 4, "latin1");
	return Buffer.concat([header, payload]);
}

/** Box using the 64-bit "largesize" form. */
function largeBox(type, payload) {
	const header = Buffer.alloc(16);
	header.writeUInt32BE(1, 0);
	header.write(type, 4, "latin1");
	header.writeBigUInt64BE(BigInt(16 + payload.length), 8);
	return Buffer.concat([header, payload]);
}

const ftyp = box("ftyp", Buffer.from("isom\0\0\0\0isomiso2mp41", "latin1"));
const payload = Buffer.alloc(64, 0xab);

let dir;
const write = async (name, ...boxes) => {
	const p = join(dir, name);
	await writeFile(p, Buffer.concat(boxes));
	return p;
};

test.before(async () => { dir = await mkdtemp(join(tmpdir(), "mp4-test-")); });
test.after(async () => { await rm(dir, { recursive: true, force: true }); });

test("progressive file with moov first is streamable and not fragmented", async () => {
	const p = await write("ok.mp4", ftyp, box("moov", payload), box("mdat", payload));
	assert.deepEqual(await inspectMp4(p), { isMp4: true, fragmented: false, faststart: true });
});

test("moov after mdat is not faststart", async () => {
	const p = await write("slow.mp4", ftyp, box("mdat", payload), box("moov", payload));
	assert.deepEqual(await inspectMp4(p), { isMp4: true, fragmented: false, faststart: false });
});

test("moof fragments mark the file as fragmented even with moov first", async () => {
	const p = await write("dash.mp4", ftyp, box("moov", payload), box("sidx", payload), box("moof", payload), box("mdat", payload));
	assert.deepEqual(await inspectMp4(p), { isMp4: true, fragmented: true, faststart: true });
});

test("64-bit box sizes are followed correctly", async () => {
	const p = await write("large.mp4", ftyp, box("moov", payload), largeBox("mdat", payload), box("moof", payload));
	assert.deepEqual(await inspectMp4(p), { isMp4: true, fragmented: true, faststart: true });
});

test("a box extending to end of file (size 0) terminates the walk cleanly", async () => {
	const open = box("mdat", payload);
	open.writeUInt32BE(0, 0);
	const p = await write("open.mp4", ftyp, box("moov", payload), open);
	assert.deepEqual(await inspectMp4(p), { isMp4: true, fragmented: false, faststart: true });
});

test("non-MP4 content is reported as such without throwing", async () => {
	const p = await write("junk.bin", Buffer.from("this is not a video at all, just bytes"));
	assert.equal((await inspectMp4(p)).isMp4, false);
});
