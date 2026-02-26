import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# --- Bot Settings ---
BOT_TOKEN: str = os.getenv("BOT_TOKEN", "")
if not BOT_TOKEN:
    raise ValueError("BOT_TOKEN is not set. Please create a .env file with your bot token.")

# Admin user IDs (comma-separated in .env, e.g. "123456,789012")
_admin_raw = os.getenv("ADMIN_IDS", "")
ADMIN_IDS: list[int] = [int(x.strip()) for x in _admin_raw.split(",") if x.strip().isdigit()]

# --- Download Settings ---
MAX_FILE_SIZE_MB: int = int(os.getenv("MAX_FILE_SIZE_MB", "50"))
MAX_FILE_SIZE_BYTES: int = MAX_FILE_SIZE_MB * 1024 * 1024

DOWNLOAD_DIR: Path = Path(os.getenv("DOWNLOAD_DIR", "./downloads"))
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

# Cooldown between requests per user (seconds)
COOLDOWN_SECONDS: int = int(os.getenv("COOLDOWN_SECONDS", "5"))

# Max simultaneous downloads across all users
MAX_CONCURRENT_DOWNLOADS: int = int(os.getenv("MAX_CONCURRENT_DOWNLOADS", "3"))

# --- Supported Platforms ---
SUPPORTED_PLATFORMS: dict[str, list[str]] = {
    "TikTok":      ["tiktok.com", "vm.tiktok.com", "vt.tiktok.com"],
    "Instagram":   ["instagram.com"],
    "Facebook":    ["facebook.com", "fb.watch", "fb.com"],
    "Pinterest":   ["pinterest.com", "pin.it"],
    "X (Twitter)": ["twitter.com", "x.com"],
    "YouTube":     ["youtube.com", "youtu.be", "m.youtube.com"],
    "Reddit":      ["reddit.com", "redd.it", "v.redd.it"],
    "Snapchat":    ["snapchat.com", "t.snapchat.com"],
    "Threads":     ["threads.net"],
}
