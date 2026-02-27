module.exports = {
	apps: [
		{
			name: "video-downloader-bot",
			script: "src/index.js",
			cwd: "./",
			interpreter: "node",
			node_args: "--experimental-vm-modules",
			env: {
				NODE_ENV: "production",
			},
			autorestart: true,
			restart_delay: 5000,
			watch: false,
			max_memory_restart: "400M",
			error_file: "logs/pm2-error.log",
			out_file: "logs/pm2-out.log",
			log_date_format: "YYYY-MM-DD HH:mm:ss",
		},
	],
};
