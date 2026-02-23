import uuid
import logging
from pathlib import Path
from typing import Any, Callable

import yt_dlp

from bot.config import DOWNLOAD_DIR, MAX_FILE_SIZE_BYTES

logger = logging.getLogger(__name__)


class DownloadError(Exception):
    """Raised when a video download fails."""
    pass


class FileTooLargeError(Exception):
    """Raised when the downloaded file exceeds the Telegram size limit."""
    pass


def _get_ydl_opts(
    output_path: str,
    progress_hook: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """
    Build yt-dlp options optimized for high-quality, watermark-free downloads.
    """
    opts: dict[str, Any] = {
        # Best MP4 video + M4A audio, fallback to best combined stream
        "format": (
            "bestvideo[ext=mp4]+bestaudio[ext=m4a]/"
            "bestvideo+bestaudio/"
            "best"
        ),
        "merge_output_format": "mp4",
        "outtmpl": output_path,

        # Single video only, no playlists
        "noplaylist": True,

        # Network
        "socket_timeout": 30,
        "retries": 3,
        "fragment_retries": 3,

        # Avoid geo-restrictions where possible
        "geo_bypass": True,

        # Quiet logging (we handle our own)
        "quiet": True,
        "no_warnings": True,

        # Ensure we get the clean (no watermark) version
        "extractor_args": {
            "tiktok": {
                "api_hostname": ["api22-normal-c-useast2a.tiktokv.com"],
            },
        },

        # Post-processing: embed metadata
        "postprocessors": [
            {
                "key": "FFmpegMetadata",
            },
        ],
    }

    if progress_hook:
        opts["progress_hooks"] = [progress_hook]

    return opts


def download_video(
    url: str,
    progress_hook: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """
    Download a video and return info about the result.

    Returns a dict with:
        - file_path: str — path to the downloaded file
        - title: str — video title
        - duration: int — duration in seconds
        - platform: str — extractor name

    Raises:
        DownloadError: if yt-dlp fails to download
        FileTooLargeError: if the file exceeds Telegram limits
    """
    file_id = uuid.uuid4().hex[:12]
    output_path = str(DOWNLOAD_DIR / f"{file_id}.%(ext)s")

    opts = _get_ydl_opts(output_path, progress_hook)

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)

            if info is None:
                raise DownloadError("Could not extract video information.")

            # resolve the actual output filename
            file_path = ydl.prepare_filename(info)
            # yt-dlp may change extension after merge
            merged_path = Path(file_path).with_suffix(".mp4")
            if merged_path.exists():
                file_path = str(merged_path)
            elif not Path(file_path).exists():
                # search for the file with our ID prefix
                for f in DOWNLOAD_DIR.iterdir():
                    if f.name.startswith(file_id):
                        file_path = str(f)
                        break

            # Check file size
            file_size = Path(file_path).stat().st_size
            if file_size > MAX_FILE_SIZE_BYTES:
                # Clean up oversized file
                Path(file_path).unlink(missing_ok=True)
                size_mb = file_size / (1024 * 1024)
                raise FileTooLargeError(
                    f"Video is {size_mb:.1f} MB, which exceeds the "
                    f"{MAX_FILE_SIZE_BYTES // (1024*1024)} MB Telegram limit."
                )

            return {
                "file_path": file_path,
                "title": info.get("title", "Video"),
                "duration": info.get("duration", 0),
                "platform": info.get("extractor", "unknown"),
                "uploader": info.get("uploader", "Unknown"),
                "thumbnail": info.get("thumbnail"),
            }

    except FileTooLargeError:
        raise
    except yt_dlp.utils.DownloadError as e:
        raise DownloadError(f"Download failed: {e}") from e
    except Exception as e:
        raise DownloadError(f"An unexpected error occurred: {e}") from e


def cleanup_file(file_path: str) -> None:
    """Remove a downloaded file."""
    try:
        Path(file_path).unlink(missing_ok=True)
    except OSError as e:
        logger.warning(f"Failed to clean up {file_path}: {e}")
