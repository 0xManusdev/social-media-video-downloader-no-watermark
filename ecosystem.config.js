module.exports = {
    apps: [
        {
            name: "video-downloader-bot",
            script: "python3",
            args: "-m bot.main",
            cwd: "./",
            interpreter: "none", // Using python3 as the script instead
            env: {
                NODE_ENV: "production",
            },
            // Restart on crash
            autorestart: true,
            watch: false,
            max_memory_restart: "500M",
            // Logging
            error_file: "logs/pm2-error.log",
            out_file: "logs/pm2-out.log",
            log_date_format: "YYYY-MM-DD HH:mm:ss",
        },
    ],
};
