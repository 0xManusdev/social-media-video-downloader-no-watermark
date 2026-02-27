import logging
import asyncio
import uuid
from pathlib import Path

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.constants import ChatAction, ParseMode
from telegram.ext import (
    ContextTypes,
    CommandHandler,
    MessageHandler,
    CallbackQueryHandler,
    filters,
)

from bot.config import SUPPORTED_PLATFORMS, ADMIN_IDS, COOLDOWN_SECONDS
from bot.downloader import (
    download_video_async, 
    cleanup_file, 
    DownloadError, 
    FileTooLargeError
)
from bot.utils import extract_urls, identify_platform, format_file_size, get_file_size, _escape_html
from bot.stats import stats
from bot import queue_manager

logger = logging.getLogger(__name__)

# Cooldown tracking
_user_last_request: dict[int, float] = {}

# URL storage: short_id -> url (avoids Telegram's 64-byte callback_data limit)
_pending_urls: dict[str, str] = {}


def _store_url(url: str) -> str:
    """Store a URL and return a short 8-char key for callback_data."""
    short_id = uuid.uuid4().hex[:8]
    _pending_urls[short_id] = url
    return short_id


def _pop_url(short_id: str) -> str | None:
    """Retrieve and remove a stored URL by its short key."""
    return _pending_urls.pop(short_id, None)


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /start — welcome message."""
    user_id = update.effective_user.id
    stats.record_user(user_id)
    platforms = ", ".join(SUPPORTED_PLATFORMS.keys())
    text = (
        "👋 <b>Welcome to the Video Downloader Bot!</b>\n\n"
        "I can download videos from:\n"
        f"<i>{platforms}</i>\n\n"
        "⚡ <b>How to use:</b>\n"
        "Just send me a link, and I'll ask if you want it as a <b>Video</b> or <b>Audio (MP3)</b>.\n\n"
        "💡 <i>Tip: You can send multiple links in one message!</i>\n"
        "👤 <i>Need your ID? Use /id</i>"
    )
    await update.message.reply_text(text, parse_mode=ParseMode.HTML)


async def id_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /id — return the user's ID."""
    user_id = update.effective_user.id
    await update.message.reply_text(f"Your Telegram ID is: {user_id}")


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /help — usage instructions."""
    lines = [
        "📖 <b>Usage Guide</b>\n",
        "1. Copy a URL from a supported site.",
        "2. Paste it here.",
        "3. Choose the format (Video/Audio).",
        "4. Wait for the file to be processed.\n",
        "<b>Supported Platforms:</b>"
    ]
    for platform in sorted(SUPPORTED_PLATFORMS.keys()):
        lines.append(f"• {platform}")
    
    lines.append("\n<b>Commands:</b>")
    lines.append("/status - Check bot load & queue")
    lines.append("/stats - Global download statistics")
    
    await update.message.reply_text("\n".join(lines), parse_mode=ParseMode.HTML)


async def status_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /status — queue information."""
    active = queue_manager.active_downloads()
    depth = queue_manager.queue_depth()
    
    text = (
        "🛰 <b>Bot Status</b>\n\n"
        f"Active downloads: <b>{active}</b>\n"
        f"Global queue depth: <b>{depth}</b>\n\n"
        "✅ The bot is running normally."
    )
    await update.message.reply_text(text, parse_mode=ParseMode.HTML)


async def stats_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /stats — admin-only global statistics."""
    if update.effective_user.id not in ADMIN_IDS:
        await update.message.reply_text("🔒 This command is restricted to admins.")
        return
    await update.message.reply_text(stats.summary_text(), parse_mode=ParseMode.HTML)


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle incoming text messages — detect URLs and show format choice."""
    if not update.message or not update.message.text:
        return

    user_id = update.effective_user.id
    stats.record_user(user_id)
    text = update.message.text.strip()

    urls = extract_urls(text)
    if not urls:
        return

    # Cooldown check
    now = asyncio.get_running_loop().time()
    last = _user_last_request.get(user_id, 0)
    if now - last < COOLDOWN_SECONDS:
        remaining = int(COOLDOWN_SECONDS - (now - last))
        await update.message.reply_text(f"⏳ Slow down! Wait {remaining}s.")
        return
    _user_last_request[user_id] = now

    for url in urls[:3]:
        platform = identify_platform(url)
        if not platform:
            continue

        # Store URL with a short ID for callback_data (Telegram 64-byte limit)
        sid = _store_url(url)

        keyboard = [
            [
                InlineKeyboardButton("🎬 Video", callback_data=f"dl|v|{sid}"),
                InlineKeyboardButton("🎵 Audio (MP3)", callback_data=f"dl|a|{sid}"),
            ]
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)
        
        await update.message.reply_text(
            f"🎯 <b>Found {platform} link!</b>\n"
            "Choose your format:",
            reply_markup=reply_markup,
            parse_mode=ParseMode.HTML,
            reply_to_message_id=update.message.message_id
        )


async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle format choice selection."""
    query = update.callback_query
    await query.answer()
    
    data = query.data.split("|")
    if data[0] != "dl" or len(data) != 3:
        return

    mode = data[1]  # 'v' or 'a'
    short_id = data[2]
    user_id = update.effective_user.id
    audio_only = (mode == 'a')

    # Retrieve the stored URL
    url = _pop_url(short_id)
    if not url:
        await query.edit_message_text("⚠️ This link has expired. Please send it again.")
        return
    
    platform = identify_platform(url) or "Unknown"
    
    # Update message to show "waiting in queue"
    await query.edit_message_text(
        f"⏳ Processing <b>{platform}</b>...\n"
        f"Format: {'🎵 Audio' if audio_only else '🎬 Video'}\n"
        "<i>Waiting for a download slot...</i>",
        parse_mode=ParseMode.HTML
    )

    acquired = False
    try:
        # Acquire slot in queue
        await queue_manager.acquire(user_id)
        acquired = True
        
        stats.record_attempt()
        await query.edit_message_text(f"📥 Downloading from <b>{platform}</b>...", parse_mode=ParseMode.HTML)
        
        # Action feedback
        action = ChatAction.UPLOAD_DOCUMENT if audio_only else ChatAction.UPLOAD_VIDEO
        await query.message.chat.send_action(action)
        
        # Download
        logger.info(f"Starting download: {url} (audio_only={audio_only})")
        result = await download_video_async(url, audio_only=audio_only)
        logger.info(f"Download complete: {result['file_path']}")
        
        file_path = result["file_path"]
        title = result["title"]
        duration = result.get("duration", 0)
        uploader = result.get("uploader", "Unknown")

        # Prepare caption
        icon = "🎵" if audio_only else "🎬"
        caption = (
            f"{icon} <b>{_escape_html(title)}</b>\n"
            f"👤 {_escape_html(uploader)}\n"
            f"📱 {platform}"
        )
        if duration:
            mins, secs = divmod(int(duration), 60)
            caption += f"  ⏱ {mins}:{secs:02d}"
        
        file_size = get_file_size(file_path)
        caption += f"\n📦 {format_file_size(file_size)}"

        # Upload
        await query.edit_message_text("📤 Uploading...")
        await query.message.chat.send_action(action)
        
        logger.info(f"Uploading {file_path} ({format_file_size(file_size)})")
        with open(file_path, "rb") as f:
            if audio_only:
                await query.message.reply_audio(
                    audio=f,
                    caption=caption,
                    title=title,
                    performer=uploader,
                    duration=int(duration),
                    parse_mode=ParseMode.HTML,
                    read_timeout=120,
                    write_timeout=120,
                )
            else:
                await query.message.reply_video(
                    video=f,
                    caption=caption,
                    duration=int(duration),
                    parse_mode=ParseMode.HTML,
                    supports_streaming=True,
                    read_timeout=120,
                    write_timeout=120,
                )
        
        # Cleanup and stats
        cleanup_file(file_path)
        stats.record_success(platform, user_id)
        await query.delete_message()
        logger.info(f"Successfully sent to user {user_id}")

    except FileTooLargeError as e:
        stats.record_too_large()
        await query.edit_message_text(f"❌ <b>Too Large</b>\n\n{e}", parse_mode=ParseMode.HTML)
    except DownloadError as e:
        stats.record_failure()
        logger.error(f"Download error for {url}: {e}")
        await query.edit_message_text(f"❌ <b>Download Failed</b>\n\n{e}", parse_mode=ParseMode.HTML)
    except Exception as e:
        logger.exception(f"Unexpected error in callback for {url}")
        stats.record_failure()
        await query.edit_message_text("❌ <b>An unexpected error occurred.</b>", parse_mode=ParseMode.HTML)
    finally:
        if acquired:
            await queue_manager.release(user_id)


# ─────────────────────── Handler Registration ────────────────────

def get_handlers() -> list:
    """Return all handlers to register with the bot."""
    return [
        CommandHandler("start", start_command),
        CommandHandler("id", id_command),
        CommandHandler("help", help_command),
        CommandHandler("status", status_command),
        CommandHandler("stats", stats_command),
        MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message),
        CallbackQueryHandler(handle_callback),
    ]
