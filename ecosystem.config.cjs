/**
 * PM2 Ecosystem Configuration for Archive API
 *
 * NOTE: This file MUST remain CommonJS (`ecosystem.config.cjs`, not `.mjs`
 * or `.ts`). PM2's `--env` flag (`pm2 start --env production`) and the
 * `pm2` CLI itself both expect a CJS module via `require()`. Converting
 * to ESM would break `pm2 start`, `pm2 reload`, and `pm2 resurrect`.
 *
 * Prerequisites:
 * - FlareSolverr must be running on FLARESOLVERR_BASE_URL (default: http://localhost:8191)
 *   See: https://github.com/FlareSolverr/FlareSolverr
 *
 * Docker:
 *   docker run -d --name flaresolverr -p 8191:8191 \
 *     -e LOG_LEVEL=info ghcr.io/flaresolverr/flaresolverr:latest
 *
 * Non-Docker (Linux):
 *   sudo apt install -y chromium-browser xvfb
 *   pip install flaresolverr
 *   flaresolverr --port 8191
 *
 * Non-Docker (Windows):
 *   Download from https://github.com/FlareSolverr/FlareSolverr/releases
 *   Run: flaresolverr.exe --port 8191
 *
 * Defines two app instances running under a single PM2 process manager (Linux production server):
 * 1. archive-api - HTTP REST endpoints (Fastify/Feathers)
 * 2. archive-worker - Background job processors + stream detection monitoring (BullMQ + FlareSolverr via HTTP)
 *
 * Required environment variables (set in .env or PM2 runtime env):
 *   NODE_ENV              - "production" or "development"
 *
 * Deployment on Linux:
 *   npm install && npm run start:pm2
 *
 * Log rotation (pm2-logrotate):
 *   pm2 install pm2-logrotate
 *   pm2 set pm2-logrotate:rotate_interval daily
 *   pm2 set pm2-logrotate:retain 7
 *   pm2 set pm2-logrotate:compress true
 *   pm2 set pm2-logrotate:max_size 100M
 */

const path = require('path');

module.exports = {
  apps: [
    // === PREREQUISITE: PgBouncer (Required — Connection Pooler) ===
    // Install: sudo apt install pgbouncer
    // Configure: /etc/pgbouncer/pgbouncer.ini (see pgbouncer.ini in repo root)
    // Auth file: /etc/pgbouncer/userlist.txt
    // Pool mode: transaction | Listen: 127.0.0.1:6432
    // Docker: docker run -d --name pgbouncer -p 6432:6432 -v /path/to/pgbouncer.ini:/etc/pgbouncer/pgbouncer.ini postgres
    // PGBOUNCER_URL in .env is required — all DB connections route through it
    //
    // === APP #1: HTTP API Server (Fastify/Feathers REST endpoints) ===
    {
      name: 'api', // PM2 app identifier

      cwd: __dirname,

      script: './dist/src/index.js', // Compiled output from tsc build

      interpreter: 'node',

      env: {
        // Production environment (default)
        NODE_ENV: 'production',
      },

      max_memory_restart: '512M', // Restart if memory exceeds this limit (lightweight API server)

      autorestart: true, // Auto-recover on crashes or OOM events
      watch: false, // Disable file watching in production

      instances: 1, // Single instance per app
      exec_mode: 'fork', // Standard process mode

      kill_timeout: 10000, // Allow graceful shutdown before PM2 force-kills

      merge_logs: true, // Combine stdout + stderr into single log file

      out_file: path.join(__dirname, 'logs', 'api-out.log'),
      error_file: path.join(__dirname, 'logs', 'api-error.log'),
    },

    // === APP #2: Background Workers + Stream Monitoring (BullMQ queues + FlareSolverr for Kick API access) ===
    {
      name: 'worker', // Separate PM2 app identifier

      cwd: __dirname,

      script: './dist/src/workers/index.js', // Worker entry point - BullMQ job processors

      interpreter: 'node',

      env: {
        // Production worker settings
        NODE_ENV: 'production',
      },

      max_memory_restart: '2G', // Higher limit needed - CycleTLS (~200MB) + 50 live workers + VOD downloads with concurrent HLS segment buffering

      autorestart: true, // Auto-recover on crashes
      watch: false, // Disable file watching in production
      instances: 1,
      exec_mode: 'fork',

      kill_timeout: 10000, // Allow graceful shutdown before PM2 force-kills

      merge_logs: true, // Combine streams for cleaner log viewing

      out_file: path.join(__dirname, 'logs', 'worker-out.log'),
      error_file: path.join(__dirname, 'logs', 'worker-error.log'),
    },
  ],
};
