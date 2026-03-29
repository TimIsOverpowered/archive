/**
 * PM2 Ecosystem Configuration for Archive API
 *
 * Defines three app instances running under a single PM2 process manager (Linux production server):
 * 1. archive-api - HTTP REST endpoints (Fastify/Feathers)
 * 2. archive-worker - Background job processors (BullMQ + Puppeteer)
 * 3. archive-monitor - Stream detection and monitoring service
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

      interpreter: 'tsx', // Use tsx for TS execution without build step

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

      merge_logs: true, // Combine stdout + stderr into single log file

      out_file: './logs/api-out.log', // Pretty-printed console output from pino-pretty transport
      error_file: './logs/api-error.log', // Uncaught errors and exceptions
    },

    // === APP #2: Background Workers (BullMQ queues + Puppeteer for VOD/Chat downloads & YouTube uploads) ===
    {
      name: 'archive-worker', // Separate PM2 app identifier

      script: './src/workers/index.ts', // Worker entry point - BullMQ job processors

      interpreter: 'tsx', // TypeScript support via tsx

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

      merge_logs: true, // Combine streams for cleaner log viewing

      out_file: './logs/worker-out.log', // Worker stdout with pretty pino logs from console transport
      error_file: './logs/worker-error.log', // Worker uncaught errors and exceptions
    },

    // === APP #3: Stream Monitoring Service (detects live streams, triggers VOD downloads) ===
    {
      name: 'archive-monitor', // Monitor service app identifier

      script: './src/monitor-service.js', // Monitor entry point

      interpreter: 'tsx', // TypeScript support via tsx

      env: {
        // Production monitor settings
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
      },

      env_development: {
        // Development mode for monitor
        NODE_ENV: 'development',
        LOG_LEVEL: 'debug',
      },

      max_memory_restart: '384M', // Moderate memory usage (stream polling, lightweight compared to workers)

      autorestart: true,
      watch: false,
      instances: 1,
      exec_mode: 'fork',

      merge_logs: true, // Combine stdout + stderr

      out_file: './logs/monitor-out.log', // Monitor service console output
      error_file: './logs/monitor-error.log', // Uncaught errors from monitor process
    },
  ],
};
