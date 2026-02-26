import logging
import asyncio
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

async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /start — welcome message."""
    platforms = ", ".join(SUPPORTED_PLATFORMS.keys())
    text = (
        "👋 <b>Welcome to the Video Downloader Bot!</b>\n\n"
        "I can download videos from:\n"
        f"<i>{platforms}</i>\n\n"
        "⚡ <b>How to use:</b>\n"
        "Just send me a link, and I'll ask if you want it as a <b>Video</b> or <b>Audio (MP3)</b>.\n\n"
        "💡 <i>Tip: You can send multiple links in one message!</i>"
    )
    await update.message.reply_text(text, parse_mode=ParseMode.HTML)


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
    """Handle /stats — global statistics."""
    # Everyone can see basic stats
    await update.message.reply_text(stats.summary_text(), parse_mode=ParseMode.HTML)


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle incoming text messages — detect URLs and show format choice."""
    if not update.message or not update.message.text:
        return

    user_id = update.effective_user.id
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

    for url in urls[:3]: # Limit to 3 URLs per message to avoid spam
        platform = identify_platform(url)
        if not platform:
            continue

        # Show keyboard for format choice
        keyboard = [
            [
                InlineKeyboardButton("🎬 Video", callback_data=f"dl|v|{url}"),
                InlineKeyboardButton("🎵 Audio (MP3)", callback_data=f"dl|a|{url}"),
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
    if data[0] != "dl":
        return

    mode = data[1] # 'v' or 'a'
    url = "|".join(data[2:]) # Rejoin URL if it contained pipes (unlikely but safe)
    user_id = update.effective_user.id
    audio_only = (mode == 'a')
    
    platform = identify_platform(url) or "Unknown"
    
    # Update message to show "waiting in queue"
    await query.edit_message_text(
        f"⏳ Processing <b>{platform}</b>...\n"
        f"Format: {'🎵 Audio' if audio_only else '🎬 Video'}\n"
        "<i>Waiting for a download slot...</i>",
        parse_mode=ParseMode.HTML
    )

    try:
        # Acquire slot in queue
        await queue_manager.acquire(user_id)
        
        stats.record_attempt()
        await query.edit_message_text(f"📥 Downloading from <b>{platform}</b>...", parse_mode=ParseMode.HTML)
        
        # Action feedback
        action = ChatAction.UPLOAD_DOCUMENT if audio_only else ChatAction.UPLOAD_VIDEO
        await query.message.chat.send_action(action)
        
        # Download
        result = await download_video_async(url, audio_only=audio_only)
        
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
        
        with open(file_path, "rb") as f:
            if audio_only:
                await query.message.reply_audio(
                    audio=f,
                    caption=caption,
                    title=title,
                    performer=uploader,
                    duration=int(duration),
                    parse_mode=ParseMode.HTML
                )
            else:
                await query.message.reply_video(
                    video=f,
                    caption=caption,
                    duration=int(duration),
                    parse_mode=ParseMode.HTML,
                    supports_streaming=True
                )
        
        # Cleanup and stats
        cleanup_file(file_path)
        stats.record_success(platform, user_id)
        await query.delete_message()

    except FileTooLargeError as e:
        stats.record_too_large()
        await query.edit_message_text(f"❌ <b>Too Large</b>\n\n{e}", parse_mode=ParseMode.HTML)
    except DownloadError as e:
        stats.record_failure()
        await query.edit_message_text(f"❌ <b>Download Failed</b>\n\n{e}", parse_mode=ParseMode.HTML)
    except Exception as e:
        logger.exception("Callback error")
        stats.record_failure()
        await query.edit_message_text("❌ <b>An unexpected error occurred.</b>", parse_mode=ParseMode.HTML)
    finally:
        queue_manager.release(user_id)


# ─────────────────────── Handler Registration ────────────────────

def get_handlers() -> list:
    """Return all handlers to register with the bot."""
    return [
        CommandHandler("start", start_command),
        CommandHandler("help", help_command),
        CommandHandler("status", status_command),
        CommandHandler("stats", stats_command),
        MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message),
        CallbackQueryHandler(handle_callback),
    ]
