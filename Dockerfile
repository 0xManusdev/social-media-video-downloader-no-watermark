# ── Stage 1: dependencies and the yt-dlp binary ─────────────────────
FROM node:20-slim AS build

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

# Must be a build that bundles curl_cffi. The plain "yt-dlp" zipimport asset does not,
# and without browser impersonation Instagram redirects every anonymous post to its login page.
RUN case "$(dpkg --print-architecture)" in \
        amd64) asset=yt-dlp_linux ;; \
        arm64) asset=yt-dlp_linux_aarch64 ;; \
        *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}" \
        -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

# ── Stage 2: runtime ─────────────────────────────────────────────────
FROM node:20-slim

ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /usr/local/bin/yt-dlp /usr/local/bin/yt-dlp
RUN yt-dlp --version

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package*.json ./
COPY src/ ./src/

RUN mkdir -p downloads \
    && useradd -m botuser \
    && chown -R botuser:botuser /app
USER botuser

CMD ["node", "src/index.js"]
