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
    """Extract all distinct normalized URLs from a text message."""
    raw_urls = URL_REGEX.findall(text)
    # Remove duplicates while preserving order
    seen = set()
    unique_urls = []
    for url in raw_urls:
        norm = normalize_url(url)
        if norm not in seen:
            seen.add(norm)
            unique_urls.append(norm)
    return unique_urls


def normalize_url(url: str) -> str:
    """Strip common tracking parameters from URLs."""
    try:
        parsed = urlparse(url)
        # Simple query param filtering (e.g. for TikTok/Instagram tracking)
        # Keep basic URL without massive tracking strings
        if "tiktok.com" in (parsed.hostname or ""):
            # Strip everything after '?' for TikTok
            return f"{parsed.scheme}://{parsed.hostname}{parsed.path}"
        return url
    except Exception:
        return url


def sanitize_filename(filename: str) -> str:
    """Remove characters that are unsafe for filenames."""
    # Keep alphanumeric, spaces, and basic punctuation
    sanitized = re.sub(r'[^\w\s\-\.]', '', filename)
    return sanitized.strip()[:100]  # Cap length


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


def _escape_html(text: str) -> str:
    """Escape HTML special characters for Telegram messages."""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


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
