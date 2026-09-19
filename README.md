# Video Downloader Bot

Telegram bot that downloads videos and photo posts from social networks with **yt-dlp** and
sends them back in the chat as H.264/AAC MP4 files that play reliably in Telegram's mobile
and desktop clients.

## Supported platforms

TikTok (videos and photo slideshows), Instagram (reels, videos, photo posts and carousels),
Facebook, Pinterest, X (Twitter), YouTube, Reddit, Snapchat, Threads.

## Prerequisites

- **Node.js 20+**
- **FFmpeg** on `PATH` — merges separate video/audio streams and normalizes containers
- **yt-dlp with browser impersonation** — Instagram TLS-fingerprints requests, so yt-dlp must
  be built with `curl_cffi` or every Instagram post is redirected to the login page
  - Standalone binary: use `yt-dlp_linux` / `yt-dlp_linux_aarch64` / `yt-dlp.exe` — **not** the
    plain `yt-dlp` zipimport asset, which is the one build that omits `curl_cffi`
  - pip: `pip install -r requirements.txt` (installs `yt-dlp[default,curl-cffi]`)
  - Verify: `yt-dlp --list-impersonate-targets` must list Chrome/Edge/Safari targets
- A **Telegram bot token** from [@BotFather](https://t.me/BotFather)

## Setup

```bash
npm ci
cp .env.example .env   # then set BOT_TOKEN (and COOKIES_FILE, see below)
npm start              # or: npm run dev (restarts on change)
```

Run the tests with `npm test`.

### PM2

```bash
pm2 start ecosystem.config.cjs
```

### Docker

The image ships ffmpeg and an impersonation-capable yt-dlp build; nothing else is needed.

```bash
docker build -t video-downloader-bot .
docker run -d --name video-downloader-bot --env-file .env video-downloader-bot
```

The image copies `src/` at build time: **rebuild after every code change**.

To use cookies, mount the file and point `COOKIES_FILE` at it:

```bash
docker run -d --env-file .env \
    -v /path/to/cookies.txt:/app/cookies.txt \
    -e COOKIES_FILE=/app/cookies.txt \
    video-downloader-bot
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `BOT_TOKEN` | — | Telegram Bot API token (required) |
| `ADMIN_IDS` | — | Comma-separated Telegram user IDs allowed to run `/stats` |
| `COOKIES_FILE` | — | Netscape-format cookies file; required for Instagram audio and private posts |
| `MAX_FILE_SIZE_MB` | `50` | Upload cap (the Telegram Bot API limit) |
| `DOWNLOAD_DIR` | `./downloads` | Temporary directory for media files |
| `COOLDOWN_SECONDS` | `5` | Delay enforced between two links from the same user |
| `MAX_CONCURRENT_DOWNLOADS` | `3` | Simultaneous yt-dlp processes |
| `DOWNLOAD_TIMEOUT_MS` | scales with `MAX_FILE_SIZE_MB` | Hard timeout per yt-dlp run |

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/help` | Supported platforms and usage |
| `/id` | Your Telegram user ID |
| `/status` | Active downloads and queue depth |
| `/stats` | Usage statistics (admins only) |

## Project layout

```
src/
├── index.js               Bootstrap: bot creation, handlers, launch, shutdown
├── config.js              Environment-based configuration
├── queue.js               Global + per-user download slots
├── stats.js               In-memory usage counters
├── utils.js               URL extraction, platform detection, formatting
├── bot/
│   ├── commands.js        /start /help /id /status /stats
│   ├── downloadHandler.js Text-message handler: link → download → send
│   ├── telegram.js        Status edits, video and media-group uploads
│   └── cooldown.js        Per-user rate limiting
└── media/
    ├── downloader.js      Download orchestration, Instagram retries, image fallback
    ├── ytdlp.js           yt-dlp discovery, process runner, error translation
    ├── args.js            Format ladder and CLI argument builders
    ├── files.js           Locating and deleting downloaded files
    ├── mp4.js             Container inspection and stream-copy normalization
    └── errors.js          DownloadError, FileTooLargeError
test/                      node --test suites for the pure modules
```

## How media is selected

Formats are requested as **H.264 + AAC in MP4**, because Telegram's player renders AV1 and VP9
as a black screen on many clients and plays Opus-in-MP4 silently. The video stream is capped a
few MB below `MAX_FILE_SIZE_MB`, so an oversized source steps down in resolution instead of
failing — a long 1080p YouTube video is delivered at 720p rather than rejected. Raising
`MAX_FILE_SIZE_MB` above 50 requires a self-hosted Telegram Bot API server.

After download, the container is inspected. DASH sources (Instagram in particular) arrive as
**fragmented MP4** with no keyframe index, which desktop players tolerate but mobile decoders
do not: the picture freezes while the sound keeps playing. Such files are rewritten with a
stream copy — no re-encoding — that restores the index and moves `moov` to the front.

## Troubleshooting

### Instagram fails with a login redirect / "rate-limit"

Instagram checks the TLS fingerprint of the request. When yt-dlp cannot impersonate a
browser it is redirected to the login page and reports that as a rate-limit — so the message
is misleading and waiting does not help.

1. Run `yt-dlp --list-impersonate-targets`. An empty list is the problem: reinstall yt-dlp
   with `curl_cffi` (see Prerequisites). The bot also logs a warning at startup in this case.
2. If it still fails, the post genuinely requires an account: set `COOKIES_FILE`.

### Instagram videos arrive without sound

Logged out, Instagram's API reports `has_audio: false` and serves video-only streams — the
downloaded file genuinely contains a single video track, so there is nothing to recover
locally. Setting `COOKIES_FILE` is the only fix. Export cookies from a logged-in browser in
Netscape format (any "Get cookies.txt" extension).

### The picture freezes on phones while the audio plays

The file was delivered as fragmented MP4 (see *How media is selected*). This is handled
automatically; if it still happens, check the logs for `Could not normalize` — it means
ffmpeg was not found on `PATH`.
