import { loadStreamerConfigs } from '../config/loader.js';
import { startStreamDetectionLoop } from './stream-detector.js';

/**
 * Main entry point - loads ALL tenant configs and starts concurrent monitoring loops
 */
export async function startMonitorService(): Promise<void> {
  console.log('🚀 Starting Archive Monitor Service...');

  try {
    const allConfigs = await loadStreamerConfigs();

    if (allConfigs.length === 0) {
      console.warn('[Monitor] No tenant configs loaded. Check META_DATABASE_URL and Tenant table.');
      return;
    }

    console.info(`[Monitor] Loaded ${allConfigs.length} tenant config(s). Starting concurrent polling loops...`);

    for (const config of allConfigs) {
      // Start independent loop per platform - mainPlatform flag is ONLY for YouTube game uploads, NOT stream detection

      if (config.twitch?.enabled && config.twitch.username) {
        startStreamDetectionLoop(config.id, 'twitch', config);
      }

      if (config.kick?.enabled && config.kick.username) {
        startStreamDetectionLoop(config.id, 'kick', config);
      }
    }

    console.info(`[Monitor] Started polling loops across all tenants/platforms`);
  } catch (error: any) {
    console.error('[Monitor] Failed to start monitoring service:', error.message || error);

    // Exit with non-zero code so PM2 can restart the process automatically
    process.exit(1);
  }
}

/**
 * Graceful shutdown handler - clears all polling intervals and closes browser instances
 */
export async function stopMonitorService(): Promise<void> {
  console.info('[Monitor] Received shutdown signal. Cleaning up...');

  // Clear all monitor intervals
  const intervals = (globalThis as any).monitorIntervals;

  if (intervals) {
    for (const [key, intervalId] of intervals.entries()) {
      clearInterval(intervalId);
      console.info(`[Monitor] Cleared polling loop: ${key}`);
    }

    intervals.clear();
  }

  // Close Kick Puppeteer browser instance if it exists
  try {
    const closeKickBrowser = (await import('../services/kick-live.js')).closeKickBrowser;
    await closeKickBrowser?.();
    console.info('[Monitor] Closed Kick browser instance');
  } catch (err) {
    console.warn('[Monitor]', err instanceof Error ? err.message : 'Error during shutdown cleanup');
  }

  console.info('[Monitor] Shutdown complete.');
}

// Register shutdown handlers for PM2 restarts/process termination (when running as standalone service)
process.on('SIGTERM', stopMonitorService);
process.on('SIGINT', stopMonitorService);
