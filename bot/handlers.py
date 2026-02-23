import asyncio
import logging
from pathlib import Path

from telegram import Update
from telegram.constants import ChatAction, ParseMode
from telegram.ext import (
    ContextTypes,
    CommandHandler,
    MessageHandler,
    filters,
)

from bot.config import SUPPORTED_PLATFORMS
from bot.downloader import download_video, cleanup_file, DownloadError, FileTooLargeError
from bot.utils import extract_urls, identify_platform, format_file_size, get_file_size

logger = logging.getLogger(__name__)

# ── Cooldown tracking (seconds between requests per user) ──
USER_COOLDOWN = 5
_user_last_request: dict[int, float] = {}


# ─────────────────────── Command Handlers ────────────────────────

async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /start — welcome message."""
    platforms = " • ".join(SUPPORTED_PLATFORMS.keys())
    text = (
        "🎬 <b>Video Downloader Bot</b>\n\n"
        "Send me a video link and I'll download it in the best quality — "
        "without watermarks!\n\n"
        f"<b>Supported platforms:</b>\n{platforms}\n\n"
        "Just paste a link and I'll handle the rest ⚡"
    )
    await update.message.reply_text(text, parse_mode=ParseMode.HTML)


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /help — usage instructions."""
    lines = ["🔗 <b>How to use:</b>\n"]
    lines.append("1️⃣ Copy a video link from any supported platform")
    lines.append("2️⃣ Paste it here")
    lines.append("3️⃣ Wait a few seconds for the download\n")
    lines.append("<b>Supported platforms:</b>")
    for platform, domains in SUPPORTED_PLATFORMS.items():
        example = domains[0]
        lines.append(f"  • <b>{platform}</b> — {example}")
    lines.append("\n⚠️ <b>Limits:</b>")
    lines.append("  • Max file size: 50 MB")
    lines.append("  • Single videos only (no playlists)")
    await update.message.reply_text("\n".join(lines), parse_mode=ParseMode.HTML)


# ─────────────────────── Message Handler ─────────────────────────

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle incoming text messages — detect and download video URLs."""
    if not update.message or not update.message.text:
        return

    user_id = update.effective_user.id
    text = update.message.text.strip()

    # Extract URLs from the message
    urls = extract_urls(text)
    if not urls:
        return  # Ignore messages without URLs

    # Find the first supported URL
    target_url = None
    platform_name = None
    for url in urls:
        platform_name = identify_platform(url)
        if platform_name:
            target_url = url
            break

    if not target_url or not platform_name:
        await update.message.reply_text(
            "❌ Sorry, this URL is not from a supported platform.\n\n"
            "Use /help to see supported sites.",
            parse_mode=ParseMode.HTML,
        )
        return

    # Cooldown check
    now = asyncio.get_event_loop().time()
    last = _user_last_request.get(user_id, 0)
    if now - last < USER_COOLDOWN:
        remaining = int(USER_COOLDOWN - (now - last))
        await update.message.reply_text(
            f"⏳ Please wait {remaining}s before sending another link."
        )
        return
    _user_last_request[user_id] = now

    # Send "downloading" status
    status_msg = await update.message.reply_text(
        f"⏳ Downloading from <b>{platform_name}</b>...\n"
        "This may take a moment.",
        parse_mode=ParseMode.HTML,
    )

    file_path = None
    try:
        # Show typing action while downloading
        await update.message.chat.send_action(ChatAction.UPLOAD_VIDEO)

        # Download the video (runs sync yt-dlp in executor to avoid blocking)
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, download_video, target_url)

        file_path = result["file_path"]
        title = result["title"]
        duration = result.get("duration", 0)
        uploader = result.get("uploader", "Unknown")

        # Build caption
        caption_parts = [f"🎬 <b>{_escape_html(title)}</b>"]
        if uploader and uploader != "Unknown":
            caption_parts.append(f"👤 {_escape_html(uploader)}")
        caption_parts.append(f"📱 {platform_name}")
        if duration:
            mins, secs = divmod(int(duration), 60)
            caption_parts.append(f"⏱ {mins}:{secs:02d}")

        file_size = get_file_size(file_path)
        caption_parts.append(f"📦 {format_file_size(file_size)}")
        caption = "\n".join(caption_parts)

        # Update status
        await status_msg.edit_text("📤 Uploading to Telegram...")

        # Send the video
        await update.message.chat.send_action(ChatAction.UPLOAD_VIDEO)
        with open(file_path, "rb") as video_file:
            await update.message.reply_video(
                video=video_file,
                caption=caption,
                parse_mode=ParseMode.HTML,
                supports_streaming=True,
                read_timeout=120,
                write_timeout=120,
            )

        # Delete the status message
        await status_msg.delete()

    except FileTooLargeError as e:
        await status_msg.edit_text(
            f"❌ <b>File too large</b>\n\n{e}\n\n"
            "💡 Try a shorter clip or a lower quality version.",
            parse_mode=ParseMode.HTML,
        )
    except DownloadError as e:
        await status_msg.edit_text(
            f"❌ <b>Download failed</b>\n\n{_escape_html(str(e))}\n\n"
            "💡 Make sure the link is valid and the video is public.",
            parse_mode=ParseMode.HTML,
        )
    except Exception as e:
        logger.exception(f"Unexpected error processing {target_url}")
        await status_msg.edit_text(
            "❌ <b>Something went wrong</b>\n\n"
            "An unexpected error occurred. Please try again later.",
            parse_mode=ParseMode.HTML,
        )
    finally:
        # Always clean up temp files
        if file_path:
            cleanup_file(file_path)


def _escape_html(text: str) -> str:
    """Escape HTML special characters for Telegram messages."""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


# ─────────────────────── Handler Registration ────────────────────

def get_handlers() -> list:
    """Return all handlers to register with the bot."""
    return [
        CommandHandler("start", start_command),
        CommandHandler("help", help_command),
        MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message),
    ]
