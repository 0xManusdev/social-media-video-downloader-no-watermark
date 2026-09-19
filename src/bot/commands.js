import { ADMIN_IDS, PLATFORMS } from "../config.js";
import { stats } from "../stats.js";
import { queue } from "../queue.js";

/** Registered with Telegram so clients can offer them as suggestions. */
export const BOT_COMMANDS = [
	{ command: "start",  description: "Welcome message" },
	{ command: "id",     description: "Get your Telegram user ID" },
	{ command: "help",   description: "How to use the bot" },
	{ command: "status", description: "Bot queue status" },
	{ command: "stats",  description: "Statistics (admin only)" },
];

/**
 * @param {import("telegraf").Telegraf} bot
 */
export function registerCommands(bot) {
	bot.start((ctx) => {
		stats.recordUser(ctx.from.id);
		return ctx.replyWithHTML(
			`<b>Welcome to the Video Downloader Bot!</b>\n\n` +
			`I download the best quality video from:\n` +
			`<i>${Object.keys(PLATFORMS).join(", ")}</i>\n\n` +
			`Just send me a link!`
		);
	});

	bot.help((ctx) =>
		ctx.replyWithHTML(
			[
				"<b>How to use</b>\n",
				"Paste a video link — the bot downloads and sends it automatically.\n",
				"<b>Supported Platforms:</b>",
				...Object.keys(PLATFORMS).sort().map((p) => `• ${p}`),
				"\n<b>Commands:</b>",
				"/id — Your Telegram user ID",
				"/status — Queue status",
				"/stats — Statistics (admin)",
			].join("\n")
		)
	);

	bot.command("id", (ctx) => ctx.reply(`Your Telegram ID is: ${ctx.from.id}`));

	bot.command("status", (ctx) =>
		ctx.replyWithHTML(
			`<b>Bot Status</b>\n\n` +
			`Active downloads: <b>${queue.activeDownloads()}</b>\n` +
			`Waiting in queue: <b>${queue.queueDepth()}</b>`
		)
	);

	bot.command("stats", (ctx) => {
		if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply("Admin only.");
		return ctx.replyWithHTML(stats.summary());
	});
}
