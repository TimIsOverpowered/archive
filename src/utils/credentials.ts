import { configService } from '../config/tenant-config.js';
import { createAutoLogger } from './auto-tenant-logger.js';

export interface TwitchCredentials {
  clientId: string;
  clientSecret: string;
  accessToken?: string | undefined;
  expiryDate?: number | undefined;
}

/**
 * Get decrypted Twitch credentials for a tenant.
 * Returns null if not configured or decryption fails.
 */
export function getTwitchCredentials(tenantId: string): TwitchCredentials | null {
  const log = createAutoLogger(tenantId);

  const config = configService.get(tenantId);

  if (config?.twitch?.auth == null) {
    log.warn({ component: 'credentials', tenantId }, 'No auth configured for tenant');
    return null;
  }

  const auth = config.twitch.auth;

  if (auth.client_id == null || auth.client_id === '' || auth.client_secret == null || auth.client_secret === '') {
    log.error({ component: 'credentials' }, 'Missing client_id or client_secret in credentials');
    return null;
  }

  return {
    clientId: auth.client_id,
    clientSecret: auth.client_secret,
    accessToken: auth.access_token,
    expiryDate: auth.expiry_date,
  };
}
