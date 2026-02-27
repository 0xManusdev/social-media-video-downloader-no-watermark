import uuid
import logging
import asyncio
from pathlib import Path
from typing import Any, Callable

import yt_dlp

from bot.config import DOWNLOAD_DIR, MAX_FILE_SIZE_BYTES
from bot.utils import sanitize_filename

logger = logging.getLogger(__name__)


class DownloadError(Exception):
    pass


class FileTooLargeError(Exception):
    pass


def _get_ydl_opts(
    output_path: str,
    audio_only: bool = False,
    progress_hook: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    # Shared headers to look like a real browser
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-us,en;q=0.5",
        "Sec-Fetch-Mode": "navigate",
    }

    opts: dict[str, Any] = {
        "outtmpl": output_path,
        "noplaylist": True,
        "socket_timeout": 30,
        "retries": 10,
        "fragment_retries": 10,
        "geo_bypass": True,
        "quiet": False,
        "no_warnings": False,
        "http_headers": headers,
        "extractor_args": {
            "tiktok": {
                "api_hostname": ["api22-normal-c-useast2a.tiktokv.com"],
            },
        },
        "postprocessors": [],
    }

    if audio_only:
        opts["format"] = "bestaudio/best"
        opts["postprocessors"].append({
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "192",
        })
    else:
        # Always pick the absolute best quality, then merge to MP4 for Telegram
        opts["format"] = "bestvideo+bestaudio/best"
        opts["merge_output_format"] = "mp4"

    if progress_hook:
        opts["progress_hooks"] = [progress_hook]

    return opts


async def download_video_async(
    url: str,
    audio_only: bool = False,
    progress_hook: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """
    Async wrapper for download_video using asyncio.to_thread.
    """
    return await asyncio.to_thread(download_video, url, audio_only, progress_hook)


def download_video(
    url: str,
    audio_only: bool = False,
    progress_hook: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """
    Sync download logic (run in thread to avoid blocking loop).
    """
    file_id = uuid.uuid4().hex[:12]
    # Use placeholder for yt-dlp to fill extension
    output_template = str(DOWNLOAD_DIR / f"{file_id}.%(ext)s")

    opts = _get_ydl_opts(output_template, audio_only, progress_hook)

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            # Extract info first
            info = ydl.extract_info(url, download=True)

            if info is None:
                raise DownloadError("Could not extract video information.")

            # Resolve actual file path
            file_path = ydl.prepare_filename(info)
            
            # Post-processing might change the extension (e.g. merge to mp4 or convert to mp3)
            ext = "mp3" if audio_only else "mp4"
            final_path = Path(file_path).with_suffix(f".{ext}")
            
            if final_path.exists():
                file_path = str(final_path)
            elif not Path(file_path).exists():
                # Fallback: find any file starting with our ID
                for f in DOWNLOAD_DIR.iterdir():
                    if f.name.startswith(file_id):
                        file_path = str(f)
                        break
                
            if not Path(file_path).exists():
                raise DownloadError("Download finished but file not found.")

            # Check file size
            file_size = Path(file_path).stat().st_size
            if file_size > MAX_FILE_SIZE_BYTES:
                Path(file_path).unlink(missing_ok=True)
                size_mb = file_size / (1024 * 1024)
                limit_mb = MAX_FILE_SIZE_BYTES // (1024 * 1024)
                raise FileTooLargeError(
                    f"File is {size_mb:.1f} MB, which exceeds the {limit_mb} MB Telegram limit."
                )

            return {
                "file_path": file_path,
                "title": info.get("title", "Video"),
                "duration": info.get("duration", 0),
                "platform": info.get("extractor_key", "unknown"),
                "uploader": info.get("uploader", "Unknown"),
                "thumbnail": info.get("thumbnail"),
                "audio_only": audio_only,
            }

    except FileTooLargeError:
        raise
    except yt_dlp.utils.DownloadError as e:
        logger.error(f"yt-dlp error: {e}")
        raise DownloadError(f"Platform error: {str(e).split(';')[0]}") from e
    except Exception as e:
        logger.exception("Unexpected downloader error")
        raise DownloadError(f"Technical error: {e}") from e


def cleanup_file(file_path: str | None) -> None:
    """Remove a downloaded file and its sidecars (like thumbnails)."""
    if not file_path:
        return
    try:
        p = Path(file_path)
        p.unlink(missing_ok=True)
        # Also cleanup possible thumbnail sidecars if they exist
        for sidecar in p.parent.glob(f"{p.stem}.*"):
            if sidecar != p:
                sidecar.unlink(missing_ok=True)
    except OSError as e:
        logger.warning(f"Failed to clean up {file_path}: {e}")
