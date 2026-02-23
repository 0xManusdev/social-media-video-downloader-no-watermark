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
| `MAX_FILE_SIZE_MB` | `50` | Max file size for uploads (Telegram limit) |
| `DOWNLOAD_DIR` | `./downloads` | Temp directory for video files |

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
