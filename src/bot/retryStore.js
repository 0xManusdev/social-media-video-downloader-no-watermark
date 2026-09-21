import { randomBytes } from "crypto";

// Telegram callback_data is capped at 64 bytes, far too little for a URL, so the button
// carries a short id instead and the actual URL lives here until it's used or expires.
const TTL_MS = 30 * 60 * 1000;

/** @type {Map<string, { url: string, userId: number, ts: number }>} */
const store = new Map();

/**
 * @param {string} url
 * @param {number} userId
 * @returns {string} short id to embed in a callback_data button
 */
export function saveForRetry(url, userId) {
	const id = randomBytes(4).toString("hex");
	store.set(id, { url, userId, ts: Date.now() });
	return id;
}

/**
 * Consume a retry id: returns the URL once, for the user it was saved for, then invalidates it.
 * @param {string} id
 * @param {number} userId
 * @returns {string|null}
 */
export function popForRetry(id, userId) {
	const entry = store.get(id);
	if (!entry || entry.userId !== userId) return null;
	store.delete(id);
	return entry.url;
}

/** Forget retry ids old enough that their button is no longer worth honoring. */
export function sweepRetryStore() {
	const cutoff = Date.now() - TTL_MS;
	for (const [id, { ts }] of store) if (ts < cutoff) store.delete(id);
}
