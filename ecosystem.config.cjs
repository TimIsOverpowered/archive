/**
 * PM2 Ecosystem Configuration for Archive API
 *
 * Defines two app instances running under a single PM2 process manager (Linux production server):
 * 1. archive-api - HTTP REST endpoints (Fastify/Feathers)
 * 2. archive-worker - Background job processors + stream detection monitoring (BullMQ + Puppeteer)
 *
 * Deployment on Linux:
 *   npm install && npm run start:pm2
 */

module.exports = {
  apps: [
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

      kill_timeout: 10000, // Allow Puppeteer 10s to shutdown gracefully before PM2 force-kills

      merge_logs: true, // Combine stdout + stderr into single log file

      out_file: './logs/api-out.log', // Pretty-printed console output from pino-pretty transport
      error_file: './logs/api-error.log', // Uncaught errors and exceptions
    },

    // === APP #2: Background Workers + Stream Monitoring (BullMQ queues + Puppeteer for VOD/Chat downloads, YouTube uploads, and live stream detection) ===
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

      max_memory_restart: '1G', // Higher limit needed - Puppeteer browsers + video processing are memory-intensive (2x API)

      autorestart: true, // Auto-recover on crashes
      watch: false, // Disable file watching in production
      instances: 1,
      exec_mode: 'fork',

      kill_timeout: 10000, // Allow Puppeteer 10s to shutdown gracefully before PM2 force-kills

      merge_logs: true, // Combine streams for cleaner log viewing

      out_file: './logs/worker-out.log', // Worker stdout with pretty pino logs (includes stream detection polling)
      error_file: './logs/worker-error.log', // Uncaught errors and exceptions
    },
  ],
};
