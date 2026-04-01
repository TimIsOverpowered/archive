import { getAppAccessToken } from '../services/twitch';
import type { StreamerConfig as ConfigType } from '../config/types';
import { sendDiscordAlert, trackFailure, resetFailures } from '../utils/alerts.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { logger } from '../utils/logger.js';
import { extractErrorDetails } from '../utils/error.js';

const MAX_FAILURES = 3;

export async function checkTokenHealth(): Promise<void> {
  const loaderModule = await import('../config/loader');
  if (!loaderModule.getConfigs) return;

  const streamerConfigs: ConfigType[] = loaderModule.getConfigs();

  for (const config of streamerConfigs) {
    const streamerId = String(config.id);

    // Create logger with tenant context per iteration so each error is attributed to correct tenant
    const log = createAutoLogger(streamerId);

    if (config.twitch?.auth) {
      try {
        await getAppAccessToken(streamerId);
        resetFailures(`${streamerId}:twitch`);
      } catch (err: unknown) {
        const { message } = extractErrorDetails(err);
        log.error({ error: message, platform: 'Twitch' }, `Token health check failed for ${streamerId}`);

        if (trackFailure(`${streamerId}:twitch`, MAX_FAILURES)) {
          await sendDiscordAlert(`🚨 Twitch token health check failed for ${streamerId} after ${MAX_FAILURES} attempts`);
        }
      }
    }

    if (config.youtube?.auth) {
      try {
        const youtubeModule = await import('../services/youtube');

        // Use lightweight validation instead of forcing token refresh
        if ('validateYoutubeToken' in youtubeModule && typeof youtubeModule.validateYoutubeToken === 'function') {
          if (await youtubeModule.validateYoutubeToken(streamerId)) {
            resetFailures(`${streamerId}:youtube`);
          } else if (trackFailure(`${streamerId}:youtube`, MAX_FAILURES)) {
            await sendDiscordAlert(`🚨 YouTube token health check failed for ${streamerId} after ${MAX_FAILURES} attempts`);
          }
        }
      } catch (err: unknown) {
        const { message } = extractErrorDetails(err);
        log.error({ error: message, platform: 'YouTube' }, `Token health check error for ${streamerId}`);

        if (trackFailure(`${streamerId}:youtube`, MAX_FAILURES)) {
          await sendDiscordAlert(`🚨 YouTube token health check failed for ${streamerId} after ${MAX_FAILURES} attempts`);
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
