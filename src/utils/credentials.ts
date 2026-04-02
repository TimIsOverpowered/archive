import { getStreamerConfig } from '../config/loader.js';
import { decryptObject } from './encryption.js';
import { loggerWithTenant } from './logger.js';

interface TwitchAuth {
  client_id: string;
  client_secret: string;
  access_token?: string;
}

export interface TwitchCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Get decrypted Twitch credentials for a tenant.
 * Returns null if not configured or decryption fails.
 */
export function getTwitchCredentials(tenantId: string): TwitchCredentials | null {
  const log = loggerWithTenant(tenantId);
  const config = getStreamerConfig(tenantId);

  if (!config?.twitch?.auth) {
    log.warn(`[Twitch] No auth configured for tenant`);
    return null;
  }

  try {
    const auth: TwitchAuth = decryptObject(config.twitch.auth);

    if (!auth.client_id || !auth.client_secret) {
      log.error('[Twitch] Missing client_id or client_secret in decrypted credentials');
      return null;
    }

    return { clientId: auth.client_id, clientSecret: auth.client_secret };
  } catch {
    return null;
  }
}
