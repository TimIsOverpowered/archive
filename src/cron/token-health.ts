import { getAppAccessToken } from '../services/twitch';
import type { TenantConfig as ConfigType } from '../config/types';
import { sendDiscordAlert, trackFailure, resetFailures } from '../utils/discord-alerts.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { logger } from '../utils/logger.js';
import { extractErrorDetails } from '../utils/error.js';

const MAX_FAILURES = 3;

export async function checkTokenHealth(): Promise<void> {
  const loaderModule = await import('../config/loader');
  if (!loaderModule.getConfigs) return;

  const streamerConfigs: ConfigType[] = loaderModule.getConfigs();

  for (const config of streamerConfigs) {
    const tenantId = String(config.id);

    // Create logger with tenant context per iteration so each error is attributed to correct tenant
    const log = createAutoLogger(tenantId);

    if (config.twitch?.auth) {
      try {
        await getAppAccessToken(tenantId);
        resetFailures(`${tenantId}:twitch`);
      } catch (err: unknown) {
        const { message } = extractErrorDetails(err);
        log.error({ error: message, platform: 'Twitch' }, `Token health check failed for ${tenantId}`);

        if (trackFailure(`${tenantId}:twitch`, MAX_FAILURES)) {
          await sendDiscordAlert(`🚨 Twitch token health check failed for ${tenantId} after ${MAX_FAILURES} attempts`);
        }
      }
    }

    if (config.youtube?.auth) {
      try {
        const youtubeModule = await import('../services/youtube');

        // Use lightweight validation instead of forcing token refresh
        if ('validateYoutubeToken' in youtubeModule && typeof youtubeModule.validateYoutubeToken === 'function') {
          if (await youtubeModule.validateYoutubeToken(tenantId)) {
            resetFailures(`${tenantId}:youtube`);
          } else if (trackFailure(`${tenantId}:youtube`, MAX_FAILURES)) {
            await sendDiscordAlert(`🚨 YouTube token health check failed for ${tenantId} after ${MAX_FAILURES} attempts`);
          }
        }
      } catch (err: unknown) {
        const { message } = extractErrorDetails(err);
        log.error({ error: message, platform: 'YouTube' }, `Token health check error for ${tenantId}`);

        if (trackFailure(`${tenantId}:youtube`, MAX_FAILURES)) {
          await sendDiscordAlert(`🚨 YouTube token health check failed for ${tenantId} after ${MAX_FAILURES} attempts`);
        }
      }
    }
  }
}

export function startTokenHealthCron(): NodeJS.Timeout {
  checkTokenHealth();

  return setInterval(
    () => {
      checkTokenHealth().catch((err) => logger.error({ err }, 'Token health cron failed'));
    },
    60 * 60 * 1000
  );
}
