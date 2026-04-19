import { logger } from '../../utils/logger.js';
import { extractErrorDetails } from '../../utils/error.js';
import { registerAllMonitorRepeatJobs, removeMonitorRepeatJob } from './startup.js';
import { releaseBrowser } from '../../utils/puppeteer-manager.js';

export async function startMonitorService(): Promise<void> {
  logger.info('[Monitor] Starting Archive Monitor Service...');

  try {
    await registerAllMonitorRepeatJobs();
    logger.info('[Monitor] Started monitor repeat jobs');
  } catch (error: unknown) {
    const details = extractErrorDetails(error);
    logger.error(details, '[Monitor] Failed to start monitor service');
    process.exit(1);
  }
}

export async function stopMonitorService(): Promise<void> {
  logger.info('[Monitor] Received shutdown signal. Cleaning up...');

  // Close Kick Puppeteer browser instance if it exists
  try {
    await releaseBrowser();
    logger.info('[Monitor] Released puppeteer browser instance');
  } catch (err) {
    const details = extractErrorDetails(err);
    logger.warn(`Error during shutdown cleanup: ${details.message}`);
  }

  logger.info('[Monitor] Shutdown complete.');
}

export { removeMonitorRepeatJob };
