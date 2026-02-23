import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# --- Bot Settings ---
BOT_TOKEN: str = os.getenv("BOT_TOKEN", "")
if not BOT_TOKEN:
    raise ValueError("BOT_TOKEN is not set. Please create a .env file with your bot token.")

# --- Download Settings ---
MAX_FILE_SIZE_MB: int = int(os.getenv("MAX_FILE_SIZE_MB", "50"))
MAX_FILE_SIZE_BYTES: int = MAX_FILE_SIZE_MB * 1024 * 1024

DOWNLOAD_DIR: Path = Path(os.getenv("DOWNLOAD_DIR", "./downloads"))
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

# --- Supported Platforms ---
SUPPORTED_PLATFORMS: dict[str, list[str]] = {
    "TikTok": ["tiktok.com", "vm.tiktok.com"],
    "Instagram": ["instagram.com"],
    "Facebook": ["facebook.com", "fb.watch", "fb.com"],
    "Pinterest": ["pinterest.com", "pin.it"],
    "X (Twitter)": ["twitter.com", "x.com"],
}
