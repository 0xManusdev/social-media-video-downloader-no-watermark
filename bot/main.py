import logging
import sys
import asyncio
from telegram import BotCommand
from telegram.ext import ApplicationBuilder

from bot.config import BOT_TOKEN
from bot.handlers import get_handlers

# ── Logging setup ──
logging.basicConfig(
    format="%(asctime)s │ %(name)-20s │ %(levelname)-7s │ %(message)s",
    level=logging.INFO,
    stream=sys.stdout,
)
# Reduce noise from httpx / telegram internals
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("telegram").setLevel(logging.WARNING)

logger = logging.getLogger(__name__)


async def post_init(application) -> None:
    """Set bot commands on startup."""
    commands = [
        BotCommand("start", "Start the bot & welcome message"),
        BotCommand("id", "Get your Telegram User ID"),
        BotCommand("help", "How to use the bot"),
        BotCommand("status", "Check bot load & queue"),
        BotCommand("stats", "Global download statistics"),
    ]
    await application.bot.set_my_commands(commands)
    logger.info("✅ Bot commands registered.")


def main() -> None:
    """Initialize and start the Telegram bot."""
    logger.info("🚀 Starting Video Downloader Bot...")

    # Build the application
    app = (
        ApplicationBuilder()
        .token(BOT_TOKEN)
        .read_timeout(120)
        .write_timeout(120)
        .post_init(post_init)
        .build()
    )

    # Register handlers
    for handler in get_handlers():
        app.add_handler(handler)

    logger.info("✅ Bot is ready. Polling for messages...")
    
    # Run until interrupted
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
