import { getAppAccessToken } from '../services/twitch';
import type { StreamerConfig as ConfigType } from '../config/types';
import { sendDiscordAlert, trackFailure, resetFailures } from '../utils/alerts';

const MAX_FAILURES = 3;

export async function checkTokenHealth(): Promise<void> {
  const loaderModule: any = await import('../config/loader');
  if (!loaderModule.getConfigs) return;

  const streamerConfigs: ConfigType[] = loaderModule.getConfigs();

  for (const config of streamerConfigs) {
    const streamerId = config.id;

    if (config.twitch?.auth) {
      try {
        await getAppAccessToken(streamerId);
        resetFailures(`${streamerId}:twitch`);
      } catch (err: any) {
        console.error(`Twitch token health check failed for ${streamerId}:`, err.message || err);

        if (trackFailure(`${streamerId}:twitch`, MAX_FAILURES)) {
          await sendDiscordAlert(`🚨 Twitch token health check failed for ${streamerId} after ${MAX_FAILURES} attempts`);
        }
      }
    }

    if (config.youtube?.auth) {
      try {
        const youtubeModule: any = await import('../services/youtube');

        // Use lightweight validation instead of forcing token refresh
        if (await youtubeModule.validateYoutubeToken(streamerId)) {
          resetFailures(`${streamerId}:youtube`);
        } else if (trackFailure(`${streamerId}:youtube`, MAX_FAILURES)) {
          await sendDiscordAlert(`🚨 YouTube token health check failed for ${streamerId} after ${MAX_FAILURES} attempts`);
        }
      } catch (err: any) {
        console.error(`YouTube token health check error for ${streamerId}:`, err.message || err);

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
      checkTokenHealth().catch(console.error);
    },
    60 * 60 * 1000
  );
}
