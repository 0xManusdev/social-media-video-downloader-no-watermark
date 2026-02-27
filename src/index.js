import { createReadStream, statSync } from "fs";
import { Telegraf, Markup } from "telegraf";
import { message } from "telegraf/filters";

import {
  BOT_TOKEN, ADMIN_IDS, COOLDOWN_SECONDS, PLATFORMS,
} from "./config.js";
import { extractUrls, identifyPlatform, formatBytes, escapeHtml } from "./utils.js";
import { download, cleanup, DownloadError, FileTooLargeError } from "./downloader.js";
import { stats } from "./stats.js";
import { queue } from "./queue.js";

// ── Bot setup ────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

// ── Pending URL store (avoids Telegram's 64-byte callback_data limit)
const pendingUrls = new Map();
function storeUrl(url) {
  const id = Math.random().toString(36).slice(2, 10);
  pendingUrls.set(id, url);
  // Auto-expire after 10 minutes
  setTimeout(() => pendingUrls.delete(id), 10 * 60 * 1000);
  return id;
}

// ── Cooldown tracking ────────────────────────────────────────────
const lastRequest = new Map();
function checkCooldown(userId) {
  const last = lastRequest.get(userId) || 0;
  const now = Date.now();
  const diff = (now - last) / 1000;
  if (diff < COOLDOWN_SECONDS) return Math.ceil(COOLDOWN_SECONDS - diff);
  lastRequest.set(userId, now);
  return 0;
}

// ── /start ───────────────────────────────────────────────────────
bot.start((ctx) => {
  stats.recordUser(ctx.from.id);
  const platforms = Object.keys(PLATFORMS).join(", ");
  return ctx.replyWithHTML(
    `👋 <b>Welcome to the Video Downloader Bot!</b>\n\n` +
    `I can download videos from:\n<i>${platforms}</i>\n\n` +
    `⚡ <b>How to use:</b>\nSend me a link — I'll ask you: 🎬 Video or 🎵 Audio?\n\n` +
    `💡 <i>Use /id to find your Telegram user ID.</i>`
  );
});

// ── /help ────────────────────────────────────────────────────────
bot.help((ctx) => {
  const lines = [
    "📖 <b>Usage Guide</b>\n",
    "1. Copy a URL from a supported site.",
    "2. Paste it here.",
    "3. Choose Video or Audio.",
    "4. Wait for the download.\n",
    "<b>Supported Platforms:</b>",
    ...Object.keys(PLATFORMS).sort().map((p) => `• ${p}`),
    "\n<b>Commands:</b>",
    "/id — Get your Telegram user ID",
    "/status — Bot queue status",
    "/stats — Download statistics (admin)",
  ];
  return ctx.replyWithHTML(lines.join("\n"));
});

// ── /id ──────────────────────────────────────────────────────────
bot.command("id", (ctx) =>
  ctx.reply(`Your Telegram ID is: ${ctx.from.id}`)
);

// ── /status ──────────────────────────────────────────────────────
bot.command("status", (ctx) =>
  ctx.replyWithHTML(
    `🛰 <b>Bot Status</b>\n\n` +
    `Active downloads: <b>${queue.activeDownloads()}</b>\n` +
    `Queue depth: <b>${queue.queueDepth()}</b>\n\n` +
    `✅ Running normally.`
  )
);

// ── /stats ───────────────────────────────────────────────────────
bot.command("stats", (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) {
    return ctx.reply("🔒 This command is restricted to admins.");
  }
  return ctx.replyWithHTML(stats.summary());
});

// ── Text messages → detect URLs ──────────────────────────────────
bot.on(message("text"), async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return; // ignore unknown commands

  stats.recordUser(ctx.from.id);

  const urls = extractUrls(text);
  if (!urls.length) return;

  const wait = checkCooldown(ctx.from.id);
  if (wait > 0) {
    return ctx.reply(`⏳ Please wait ${wait}s before sending another link.`);
  }

  let sent = 0;
  for (const url of urls.slice(0, 3)) {
    const platform = identifyPlatform(url);
    if (!platform) continue;

    const sid = storeUrl(url);
    await ctx.replyWithHTML(
      `🎯 <b>Found ${platform} link!</b>\nChoose your format:`,
      {
        reply_to_message_id: ctx.message.message_id,
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback("🎬 Video", `dl|v|${sid}`),
            Markup.button.callback("🎵 Audio (MP3)", `dl|a|${sid}`),
          ],
        ]),
      }
    );
    sent++;
  }

  if (!sent) {
    return ctx.reply(
      "❌ That URL isn't from a supported platform.\n\nUse /help to see the list."
    );
  }
});

// ── Callback: format chosen ──────────────────────────────────────
bot.action(/^dl\|(v|a)\|(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const mode = ctx.match[1];      // 'v' or 'a'
  const sid  = ctx.match[2];
  const userId = ctx.from.id;
  const audioOnly = mode === "a";

  const url = pendingUrls.get(sid);
  if (!url) {
    return ctx.editMessageText("⚠️ This link has expired. Please send it again.");
  }
  pendingUrls.delete(sid);

  const platform = identifyPlatform(url) || "Unknown";
  const fmtLabel = audioOnly ? "🎵 Audio" : "🎬 Video";

  await ctx.editMessageText(
    `⏳ <b>${platform}</b> — ${fmtLabel}\n<i>Waiting for a download slot...</i>`,
    { parse_mode: "HTML" }
  );

  let acquired = false;
  try {
    await queue.acquire(userId);
    acquired = true;
    stats.recordAttempt();

    await ctx.editMessageText(`📥 Downloading from <b>${platform}</b>...`, { parse_mode: "HTML" });

    const result = await download(url, { audioOnly });
    const { filePath, title, duration, uploader, fileSize } = result;

    const caption =
      `${audioOnly ? "🎵" : "🎬"} <b>${escapeHtml(title)}</b>\n` +
      `👤 ${escapeHtml(uploader)}\n` +
      `📱 ${platform}` +
      (duration ? `  ⏱ ${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, "0")}` : "") +
      `\n📦 ${formatBytes(fileSize)}`;

    await ctx.editMessageText("📤 Uploading...");

    const stream = createReadStream(filePath);

    if (audioOnly) {
      await ctx.replyWithAudio(
        { source: stream },
        { caption, parse_mode: "HTML", title, performer: uploader }
      );
    } else {
      await ctx.replyWithVideo(
        { source: stream },
        { caption, parse_mode: "HTML", supports_streaming: true }
      );
    }

    cleanup(filePath);
    stats.recordSuccess(platform, userId);
    await ctx.deleteMessage();

  } catch (err) {
    if (err instanceof FileTooLargeError) {
      stats.recordTooLarge();
      await ctx.editMessageText(`❌ <b>Too Large</b>\n\n${err.message}`, { parse_mode: "HTML" });
    } else if (err instanceof DownloadError) {
      stats.recordFailure();
      await ctx.editMessageText(`❌ <b>Download Failed</b>\n\n${escapeHtml(err.message)}`, { parse_mode: "HTML" });
    } else {
      stats.recordFailure();
      console.error("Unexpected error:", err);
      await ctx.editMessageText("❌ <b>An unexpected error occurred.</b>", { parse_mode: "HTML" });
    }
  } finally {
    if (acquired) queue.release(userId);
  }
});

// ── Global error handler ─────────────────────────────────────────
bot.catch((err, ctx) => {
  console.error(`Error for ${ctx.updateType}:`, err);
});

// ── Launch ───────────────────────────────────────────────────────
await bot.telegram.setMyCommands([
  { command: "start",  description: "Welcome message" },
  { command: "id",     description: "Get your Telegram user ID" },
  { command: "help",   description: "How to use the bot" },
  { command: "status", description: "Bot queue status" },
  { command: "stats",  description: "Download statistics (admin only)" },
]);

bot.launch({ dropPendingUpdates: true });
console.log("✅ Bot is running...");

// Graceful shutdown
process.once("SIGINT",  () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
