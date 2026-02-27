# ── Stage 1: Build ──────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ── Stage 2: Runtime ─────────────────────────────────────────────
FROM node:20-slim

# Install ffmpeg + yt-dlp dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        python3 \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp as a standalone binary
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
        -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

WORKDIR /app

# Copy node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy source
COPY package*.json ./
COPY src/ ./src/

# Downloads folder
RUN mkdir -p downloads

# Non-root user for safety
RUN useradd -m botuser && chown -R botuser:botuser /app
USER botuser

CMD ["node", "src/index.js"]
