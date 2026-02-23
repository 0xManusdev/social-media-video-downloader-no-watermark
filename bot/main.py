import logging
import sys

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


def main() -> None:
    """Initialize and start the Telegram bot."""
    logger.info("🚀 Starting Video Downloader Bot...")

    # Build the application
    app = (
        ApplicationBuilder()
        .token(BOT_TOKEN)
        .read_timeout(120)
        .write_timeout(120)
        .build()
    )

    # Register handlers
    for handler in get_handlers():
        app.add_handler(handler)

    logger.info("✅ Bot is ready. Polling for messages...")
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
