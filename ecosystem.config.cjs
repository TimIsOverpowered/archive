/**
 * PM2 Ecosystem Configuration for Archive API
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
 *   DATABASE_URL          - Primary PostgreSQL connection string (used by both processes)
 *   PGBOUNCER_URL         - PgBouncer connection string (used by both processes)
 *   REDIS_URL             - Redis connection string (used by both processes)
 *   TWITCH_CLIENT_ID      - Twitch OAuth client ID (used by both processes)
 *   TWITCH_CLIENT_SECRET  - Twitch OAuth client secret (used by both processes)
 *   KICK_AUTH_TOKEN       - Kick API auth token (used by both processes)
 *   YOUTUBE_API_KEY       - YouTube Data API v3 key (used by both processes)
 *   DISCORD_WEBHOOK_URL   - Discord alert webhook URL (used by both processes)
 *   FLARESOLVERR_BASE_URL - FlareSolverr URL for Kick anti-bot (worker only, default: http://localhost:8191)
 *   NODE_ENV              - "production" or "development"
 *   PORT                  - API server port (default: 3030, API only)
 *
 * Deployment on Linux:
 *   npm install && npm run start:pm2
 */

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
      name: 'archive-api', // PM2 app identifier

      script: './src/index.ts', // Direct TypeScript via tsx interpreter

      interpreter: 'node',
      interpreter_args: '--import tsx',

      env: {
        // Production environment (default)
        NODE_ENV: 'production',
        LOG_LEVEL: 'info', // Lower verbosity - PM2 captures all logs
        PORT: 3030,
      },

      env_development: {
        // Development mode (--env development flag)
        NODE_ENV: 'development',
        LOG_LEVEL: 'debug', // Verbose logging for debugging
        PORT: 3030,
      },

      max_memory_restart: '512M', // Restart if memory exceeds this limit (lightweight API server)

      autorestart: true, // Auto-recover on crashes or OOM events
      watch: false, // Disable file watching in production

      instances: 1, // Single instance per app
      exec_mode: 'fork', // Standard process mode

      kill_timeout: 10000, // Allow graceful shutdown before PM2 force-kills

      merge_logs: true, // Combine stdout + stderr into single log file

      out_file: './logs/api-out.log', // Pretty-printed console output from pino-pretty transport
      error_file: './logs/api-error.log', // Uncaught errors and exceptions
    },

    // === APP #2: Background Workers + Stream Monitoring (BullMQ queues + FlareSolverr for Kick API access) ===
    {
      name: 'archive-worker', // Separate PM2 app identifier

      script: './src/workers/index.ts', // Worker entry point - BullMQ job processors

      interpreter: 'node',
      interpreter_args: '--import tsx',

      env: {
        // Production worker settings
        NODE_ENV: 'production',
        LOG_LEVEL: 'info', // Same as API for consistency
      },

      env_development: {
        // Development mode for workers
        NODE_ENV: 'development',
        LOG_LEVEL: 'debug', // Can match or differ from API server level
      },

      max_memory_restart: '1G', // Higher limit needed - video processing is memory-intensive (2x API)

      autorestart: true, // Auto-recover on crashes
      watch: false, // Disable file watching in production
      instances: 1,
      exec_mode: 'fork',

      kill_timeout: 10000, // Allow graceful shutdown before PM2 force-kills

      merge_logs: true, // Combine streams for cleaner log viewing

      out_file: './logs/worker-out.log', // Worker stdout with pretty pino logs (includes stream detection polling)
      error_file: './logs/worker-error.log', // Uncaught errors and exceptions
    },
  ],
};
