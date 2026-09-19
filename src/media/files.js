import { readdir, unlink, access } from "fs/promises";
import { constants as fsConstants } from "fs";
import { join } from "path";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

const extOf = (name) => name.slice(name.lastIndexOf(".")).toLowerCase();

/**
 * @param {string} p
 * @returns {Promise<boolean>}
 */
export async function fileExists(p) {
	try { await access(p, fsConstants.F_OK); return true; } catch { return false; }
}

/**
 * Find the downloaded video file for a download id, preferring mp4.
 * @param {string} dir
 * @param {string} prefix
 * @returns {Promise<string|null>}
 */
export async function findDownloadedFile(dir, prefix) {
	const mp4 = join(dir, `${prefix}.mp4`);
	if (await fileExists(mp4)) return mp4;

	const files = (await readdir(dir)).filter(
		(f) => f.startsWith(prefix) && !IMAGE_EXTS.has(extOf(f))
	);
	if (!files.length) return null;

	const preferred =
		files.find((f) => f.endsWith(".mp4")) ??
		files.find((f) => f.endsWith(".webm")) ??
		files[0];
	return join(dir, preferred);
}

/**
 * Find the downloaded images for a download id, in gallery order.
 * @param {string} dir
 * @param {string} prefix
 * @returns {Promise<string[]>}
 */
export async function findDownloadedImages(dir, prefix) {
	const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const numbered = new RegExp(`^${escaped}\\.(\\d+)\\.[^.]+$`);

	return (await readdir(dir))
		.filter((f) => f.startsWith(prefix) && IMAGE_EXTS.has(extOf(f)))
		.sort((a, b) => {
			const ma = a.match(numbered);
			const mb = b.match(numbered);
			if (ma && mb) return Number(ma[1]) - Number(mb[1]);
			return a.localeCompare(b, undefined, { numeric: true });
		})
		.map((f) => join(dir, f));
}

/**
 * @param {string|null|undefined} filePath
 */
export async function cleanup(filePath) {
	if (filePath) await unlink(filePath).catch(() => {});
}

/**
 * @param {string[]} imagePaths
 */
export async function cleanupImages(imagePaths) {
	await Promise.all(imagePaths.map((p) => unlink(p).catch(() => {})));
}
