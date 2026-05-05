import { Token } from '../constants.js';
import { getAppAccessToken } from '../services/twitch/index.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { sendDiscordAlert, trackFailure, resetFailures } from '../utils/discord-alerts.js';
import { extractErrorDetails } from '../utils/error.js';
import { getLogger } from '../utils/logger.js';

const log = createAutoLogger('token-health');

export async function checkTokenHealth(): Promise<void> {
  try {
    await getAppAccessToken();
    resetFailures('twitch');
  } catch (err: unknown) {
    const { message } = extractErrorDetails(err);
    log.error({ error: message, platform: 'Twitch' }, 'Token health check failed');

    if (trackFailure('twitch', Token.MAX_FAILURES)) {
      await sendDiscordAlert(`🚨 Twitch token health check failed after ${Token.MAX_FAILURES} attempts`);
    }
  }
}

export function startTokenHealthCron(): NodeJS.Timeout {
  void checkTokenHealth();

  return setInterval(
    () => {
      checkTokenHealth().catch((err) => {
        const details = extractErrorDetails(err);
        getLogger().error({ ...details }, 'Token health cron failed');
      });
    },
    24 * 60 * 60 * 1000
  );
}
