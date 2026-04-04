import { refreshCloudflareRanges } from '../utils/cloudflare-ip-validator.js';
import { logger } from '../utils/logger.js';

/**
 * Daily cron job to refresh Cloudflare IP ranges
 * Ensures ranges stay fresh even with low traffic
 */
export async function refreshCloudflareIpRanges(): Promise<void> {
  try {
    await refreshCloudflareRanges();
  } catch (error) {
    logger.error({ err: error instanceof Error ? error.message : error }, 'Failed to refresh Cloudflare IP ranges');
  }
}

/**
 * Start the daily Cloudflare IP ranges refresh cron
 * Returns interval ID for cleanup if needed
 */
export function startCloudflareIpRangesCron(): NodeJS.Timeout {
  // Initial run
  refreshCloudflareIpRanges();

  // Run every 24 hours
  return setInterval(
    () => {
      refreshCloudflareIpRanges().catch((err) => {
        logger.error({ err }, 'Cloudflare IP ranges cron failed');
      });
    },
    24 * 60 * 60 * 1000
  );
}
