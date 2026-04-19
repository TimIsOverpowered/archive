import { refreshCloudflareRanges } from '../utils/cloudflare-ip-validator.js';
import { logger } from '../utils/logger.js';
import { extractErrorDetails } from '../utils/error.js';

/**
 * Daily cron job to refresh Cloudflare IP ranges
 * Ensures ranges stay fresh even with low traffic
 */
export async function refreshCloudflareIpRanges(): Promise<void> {
  try {
    await refreshCloudflareRanges();
  } catch (error) {
    logger.error({ err: extractErrorDetails(error).message }, 'Failed to refresh Cloudflare IP ranges');
  }
}

/**
 * Start the daily Cloudflare IP ranges refresh cron
 * Returns interval ID for cleanup if needed
 */
export function startCloudflareIpRangesCron(): NodeJS.Timeout {
  // Run every 24 hours (no initial run - pre-fetch handles startup)
  return setInterval(
    () => {
      refreshCloudflareIpRanges().catch((err) => {
        logger.error({ err }, 'Cloudflare IP ranges cron failed');
      });
    },
    24 * 60 * 60 * 1000
  );
}
