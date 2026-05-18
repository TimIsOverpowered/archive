import { getBaseConfig } from '../config/env.js';
import { refreshCloudflareRanges } from '../utils/cloudflare-ip-validator.js';
import { extractErrorDetails } from '../utils/error.js';
import { getLogger } from '../utils/logger.js';

/**
 * Daily cron job to refresh Cloudflare IP ranges
 * Ensures ranges stay fresh even with low traffic
 */
export async function refreshCloudflareIpRanges(): Promise<void> {
  try {
    await refreshCloudflareRanges();
  } catch (error) {
    getLogger().error({ err: extractErrorDetails(error).message }, 'Failed to refresh Cloudflare IP ranges');
  }
}

/**
 * Start the daily Cloudflare IP ranges refresh cron
 * Returns interval ID for cleanup if needed
 */
export function startCloudflareIpRangesCron(): NodeJS.Timeout {
  if (!getBaseConfig().REQUIRE_CLOUDFLARE_IP) {
    return setInterval(() => {}, 24 * 60 * 60 * 1000);
  }

  // Run every 24 hours (no initial run - pre-fetch handles startup)
  return setInterval(
    () => {
      refreshCloudflareIpRanges().catch((err) => {
        const details = extractErrorDetails(err);
        getLogger().error({ ...details }, 'Cloudflare IP ranges cron failed');
      });
    },
    24 * 60 * 60 * 1000
  );
}
