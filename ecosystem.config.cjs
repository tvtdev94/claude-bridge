/**
 * PM2 daemon config for autorunclaude.
 *
 * Local:   pm2 start ecosystem.config.cjs
 * Logs:    pm2 logs autorunclaude
 * Stop:    pm2 stop autorunclaude
 * Persist: pm2 save && pm2 startup
 *
 * Note: terminal channel is disabled under PM2 (no TTY).
 * Set ENABLE_TERMINAL_CHANNEL=true only when running manually with `npm run start:dev`.
 */
module.exports = {
  apps: [
    {
      name: 'autorunclaude',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        ENABLE_TERMINAL_CHANNEL: 'false',
      },
      out_file: 'logs/out.log',
      error_file: 'logs/err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
