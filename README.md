# 🎬 TVDB — Telegram Video Downloader Bot

A Telegram bot that downloads high-quality, watermark-free videos from popular social media platforms using **yt-dlp**.

## Supported Platforms

| Platform | Watermark-Free | Domains |
|----------|:---:|---------|
| TikTok | ✅ | `tiktok.com`, `vm.tiktok.com` |
| Instagram | ✅ | `instagram.com` |
| Facebook | ✅ | `facebook.com`, `fb.watch` |
| Pinterest | ✅ | `pinterest.com`, `pin.it` |
| X (Twitter) | ✅ | `twitter.com`, `x.com` |

## Prerequisites

- **Python 3.11+**
- **yt-dlp with browser impersonation** — Instagram TLS-fingerprints requests, so yt-dlp must
  be built with `curl_cffi` or every Instagram post is redirected to the login page
  - Standalone binary: use `yt-dlp_linux` / `yt-dlp_linux_aarch64` / `yt-dlp.exe` — **not** the
    plain `yt-dlp` zipimport asset, which is the one build that omits `curl_cffi`
  - pip: `pip install "yt-dlp[default,curl-cffi]"`
  - Verify: `yt-dlp --list-impersonate-targets` must list Chrome/Edge/Safari targets
- **FFmpeg** — must be installed and in your system PATH
  - Windows: `choco install ffmpeg` or download from [ffmpeg.org](https://ffmpeg.org/download.html)
  - Linux: `sudo apt install ffmpeg`
  - macOS: `brew install ffmpeg`
- **Telegram Bot Token** — create one via [@BotFather](https://t.me/BotFather)

## Setup

1. **Clone and install dependencies:**
   ```bash
   cd tvdb
   pip install -r requirements.txt
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   # Edit .env and add your bot token
   ```

3. **Run the bot:**
   ```bash
   python -m bot.main
   ```

## Usage

1. Open your bot in Telegram
2. Send `/start` to see the welcome message
3. Paste any supported video URL
4. The bot will download and send the video back in best quality!

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and quick intro |
| `/help` | Supported platforms and usage guide |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `BOT_TOKEN` | — | Your Telegram Bot API token (required) |
| `ADMIN_IDS` | — | Comma-separated Telegram user IDs allowed to run `/stats` |
| `COOKIES_FILE` | — | Netscape-format cookies file; recommended for Instagram |
| `MAX_FILE_SIZE_MB` | `50` | Max file size for uploads (Telegram limit) |
| `DOWNLOAD_DIR` | `./downloads` | Temp directory for video files |
| `COOLDOWN_SECONDS` | `5` | Delay enforced between two links from the same user |
| `MAX_CONCURRENT_DOWNLOADS` | `3` | Max simultaneous yt-dlp processes |
| `DOWNLOAD_TIMEOUT_MS` | scales with `MAX_FILE_SIZE_MB` | Hard timeout per download |

## Troubleshooting

### Instagram fails with a login redirect / "rate-limit"

Instagram checks the TLS fingerprint of the request. When yt-dlp cannot impersonate a
browser it gets redirected to the login page, and reports that as a rate-limit — so the
message is misleading and waiting does not help.

1. Run `yt-dlp --list-impersonate-targets`. An empty list is the problem: reinstall yt-dlp
   with `curl_cffi` (see Prerequisites). The bot also logs a warning at startup in this case.
2. If it still fails, the post genuinely requires an account. Export cookies from a
   logged-in browser in Netscape format and point `COOKIES_FILE` at the file. Under Docker
   the file has to be mounted into the container:
   ```bash
   docker run -v /path/to/cookies.txt:/app/cookies.txt \
              -e COOKIES_FILE=/app/cookies.txt  ...
   ```

### Instagram videos arrive without sound

Logged out, Instagram's API reports `has_audio: false` and serves video-only streams — the
downloaded file genuinely contains a single video track, so there is nothing to recover
locally. Setting `COOKIES_FILE` is the only fix.

### Video quality and codec

Formats are requested as H.264 + AAC in MP4, because Telegram's player renders AV1 and VP9
as a black screen on many clients and plays Opus-in-MP4 silently. The video stream is also
capped a few MB below `MAX_FILE_SIZE_MB`, so an oversized source steps down in resolution
instead of failing — a long 1080p YouTube video is delivered at 720p rather than rejected.
Raising `MAX_FILE_SIZE_MB` above 50 requires a self-hosted Telegram Bot API server.

## Architecture

```
bot/
├── main.py         # Entry point, bot initialization
├── config.py       # Environment-based configuration
├── handlers.py     # Telegram command & message handlers
├── downloader.py   # yt-dlp wrapper with quality optimization
└── utils.py        # URL detection, platform identification
```
# social-media-video-downloader-no-watermark
