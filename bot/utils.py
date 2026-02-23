import re
import os
from urllib.parse import urlparse
from bot.config import SUPPORTED_PLATFORMS


# Compiled regex to extract URLs from text
URL_REGEX = re.compile(
    r"https?://(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}"
    r"\b[-a-zA-Z0-9()@:%_\+.~#?&//=]*",
    re.IGNORECASE,
)


def extract_urls(text: str) -> list[str]:
    """Extract all URLs from a text message."""
    return URL_REGEX.findall(text)


def identify_platform(url: str) -> str | None:
    """
    Identify which supported platform a URL belongs to.
    Returns the platform name or None if unsupported.
    """
    parsed = urlparse(url)
    hostname = parsed.hostname or ""
    # Strip leading "www."
    hostname = hostname.removeprefix("www.")

    for platform, domains in SUPPORTED_PLATFORMS.items():
        for domain in domains:
            if hostname == domain or hostname.endswith(f".{domain}"):
                return platform
    return None


def format_file_size(size_bytes: int) -> str:
    """Format byte size into a human-readable string."""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    else:
        return f"{size_bytes / (1024 * 1024):.1f} MB"


def get_file_size(file_path: str) -> int:
    """Get file size in bytes."""
    try:
        return os.path.getsize(file_path)
    except OSError:
        return 0
