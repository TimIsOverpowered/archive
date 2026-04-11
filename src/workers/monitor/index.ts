import { loadTenantConfigs } from '../../config/loader.js';
import { startStreamDetectionLoop } from './stream-detector.js';
import { logger } from '../../utils/logger.js';
import { extractErrorDetails } from '../../utils/error.js';

/**
 * Main entry point - loads ALL tenant configs and starts concurrent monitoring loops
 */
export async function startMonitorService(): Promise<void> {
  logger.info('[Monitor] Starting Archive Monitor Service...');

  try {
    const allConfigs = await loadTenantConfigs();

    if (allConfigs.length === 0) {
      logger.warn('[Monitor] No tenant configs loaded. Check META_DATABASE_URL and Tenant table.');
      return;
    }

    logger.info(`[Monitor] Loaded ${allConfigs.length} tenant config(s). Starting concurrent polling loops...`);

    for (const config of allConfigs) {
      // Start independent loop per platform - mainPlatform flag is ONLY for YouTube game uploads, NOT stream detection

      if (config.twitch?.enabled && config.twitch.username) {
        startStreamDetectionLoop(config.id, 'twitch', config);
      }

      if (config.kick?.enabled && config.kick.username) {
        startStreamDetectionLoop(config.id, 'kick', config);
      }
    }

    logger.info(`[Monitor] Started polling loops across all tenants/platforms`);
  } catch (error: unknown) {
    const details = extractErrorDetails(error);
    logger.error(details, '[Monitor] Failed to start monitoring service');

    // Exit with non-zero code so PM2 can restart the process automatically
    process.exit(1);
  }
}

/**
 * Graceful shutdown handler - clears all polling intervals and closes browser instances
 */
export async function stopMonitorService(): Promise<void> {
  logger.info('[Monitor] Received shutdown signal. Cleaning up...');

  // Clear all monitor intervals (now type-safe via src/types/global.d.ts)
  const globalObj = global as unknown as NodeJS.Global;
  const intervals: Map<string, ReturnType<typeof setInterval>> | undefined = globalObj.monitorIntervals;

  if (intervals) {
    for (const [key, intervalId] of intervals.entries()) {
      clearInterval(intervalId);
      logger.info(`[Monitor] Cleared polling loop: ${key}`);
    }

    intervals.clear();
  }

  // Close Kick Puppeteer browser instance if it exists
  try {
    const { releaseBrowser } = await import('../../utils/puppeteer-manager.js');
    await releaseBrowser();
    logger.info('[Monitor] Released puppeteer browser instance');
  } catch (err) {
    const details = extractErrorDetails(err);
    logger.warn(`Error during shutdown cleanup: ${details.message}`);
  }

  logger.info('[Monitor] Shutdown complete.');
}
