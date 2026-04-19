import { getTenantConfig } from '../config/loader.js';
import { decryptObject } from './encryption.js';
import { createAutoLogger as loggerWithTenant } from './auto-tenant-logger.js';
import { extractErrorDetails } from './error.js';
import type { TwitchAuthObject } from '../config/schemas.js';

export interface TwitchCredentials {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  expiryDate?: number;
}

/**
 * Get decrypted Twitch credentials for a tenant.
 * Returns null if not configured or decryption fails.
 */
export function getTwitchCredentials(tenantId: string): TwitchCredentials | null {
  const log = loggerWithTenant(tenantId);
  const config = getTenantConfig(tenantId);

  if (!config?.twitch?.auth) {
    log.warn(`[Twitch] No auth configured for tenant`);
    return null;
  }

  try {
    const auth = decryptObject<TwitchAuthObject>(config.twitch.auth);

    if (!auth.client_id || !auth.client_secret) {
      log.error('[Twitch] Missing client_id or client_secret in decrypted credentials');
      return null;
    }

    return {
      clientId: auth.client_id,
      clientSecret: auth.client_secret,
      accessToken: auth.access_token,
      expiryDate: auth.expiry_date,
    };
  } catch (error) {
    log.warn({ error: extractErrorDetails(error) }, '[Twitch] Failed to decrypt credentials');
    return null;
  }
}
