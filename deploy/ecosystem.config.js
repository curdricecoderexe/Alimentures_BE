/**
 * PM2 process file for the API on the VPS.
 *
 *   pm2 start deploy/ecosystem.config.js --env production
 *   pm2 save && pm2 startup     # survive reboots
 *
 * Single instance on purpose: the in-memory caches, Socket.IO rooms and the
 * in-process reservation-cleanup job assume one process. Scale vertically, or
 * add a Socket.IO adapter + INTERNAL_CRON=false before running more.
 */
module.exports = {
  apps: [
    {
      name: 'alimenture-api',
      script: 'index.js',
      cwd: __dirname + '/..',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '600M',
      kill_timeout: 12000, // > the app's 10 s graceful-shutdown window
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
  ],
};
