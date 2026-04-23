import { getAppAccessToken } from '../services/twitch/index.js';
import type { TenantConfig as ConfigType } from '../config/types.js';
import { sendDiscordAlert, trackFailure, resetFailures } from '../utils/discord-alerts.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { getLogger } from '../utils/logger.js';
import { extractErrorDetails } from '../utils/error.js';
import { configService } from '../config/tenant-config.js';
import { TOKEN_MAX_FAILURES } from '../constants.js';

export async function checkTokenHealth(): Promise<void> {
  const streamerConfigs: ConfigType[] = configService.getAll();

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

        if (trackFailure(`${tenantId}:twitch`, TOKEN_MAX_FAILURES)) {
          await sendDiscordAlert(
            `🚨 Twitch token health check failed for ${tenantId} after ${TOKEN_MAX_FAILURES} attempts`
          );
        }
      }
    }
  }
}

export function startTokenHealthCron(): NodeJS.Timeout {
  checkTokenHealth();

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
