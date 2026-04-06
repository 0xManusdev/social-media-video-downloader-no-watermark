# ── Stage 1: Build ──────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ \
    && npm ci --omit=dev \
    && rm -rf /var/lib/apt/lists/*

# ── Stage 2: Runtime ─────────────────────────────────────────────
FROM node:20-slim

ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        python3 \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
        -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY src/ ./src/

RUN mkdir -p downloads

RUN useradd -m botuser && chown -R botuser:botuser /app
USER botuser

CMD ["node", "src/index.js"]
