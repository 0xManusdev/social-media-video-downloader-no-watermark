import { tmpdir } from "os";
import { join } from "path";

// config.js requires a token and creates DOWNLOAD_DIR at import time; keep tests self-contained.
process.env.BOT_TOKEN ??= "test-token";
process.env.DOWNLOAD_DIR ??= join(tmpdir(), "video-downloader-bot-tests");
