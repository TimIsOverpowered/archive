import { getTwitchCredentials } from '../../utils/credentials.js';
import { extractErrorDetails } from '../../utils/error.js';
import { configService } from '../../config/tenant-config.js';
import { encryptObject, decryptObject } from '../../utils/encryption.js';
import { getMetaClient } from '../../db/meta-client.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { request } from '../../utils/http-client.js';
import { createTwitchClient, type TwitchClient } from './client.js';
import { LRUCache } from 'lru-cache';
import { TWITCH_TOKEN_URL } from '../../constants.js';
import { ConfigNotConfiguredError } from '../../utils/domain-errors.js';

const log = createAutoLogger('twitch-auth');

const accessTokenCache = new LRUCache<string, { token: string; expiresAt: number }>({
  max: 50,
  ttl: 55 * 60 * 1000,
  allowStale: false,
  updateAgeOnGet: true,
});

interface TwitchAuth {
  client_id: string;
  client_secret: string;
  access_token?: string | undefined;
  expiry_date?: number | undefined;
}

export async function getAppAccessToken(tenantId: string): Promise<string> {
  const cached = accessTokenCache.get(tenantId);
  if (cached != null && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const creds = getTwitchCredentials(tenantId);
  if (!creds) {
    throw new ConfigNotConfiguredError(`Twitch credentials for tenant ${tenantId}`);
  }

  if (creds.accessToken != null && creds.expiryDate != null && creds.expiryDate > 0) {
    const oneHourFromNow = Date.now() + 60 * 60 * 1000;

    if (creds.expiryDate > oneHourFromNow) {
      accessTokenCache.set(tenantId, { token: creds.accessToken, expiresAt: creds.expiryDate });
      return creds.accessToken;
    }
  }

  const url = new URL(TWITCH_TOKEN_URL);
  url.searchParams.append('client_id', creds.clientId);
  url.searchParams.append('client_secret', creds.clientSecret);
  url.searchParams.append('grant_type', 'client_credentials');

  const data = await request<{ access_token: string; expires_in: number }>(url.toString(), {
    method: 'POST',
  });

  const { access_token, expires_in } = data;
  const expiryDate = Date.now() + expires_in * 1000;

  accessTokenCache.set(tenantId, { token: access_token, expiresAt: expiryDate });

  log.info({ tenantId, expires_in, expiry_date: expiryDate }, 'Fetched new Twitch access token');

  try {
    await updateTwitchTokenInDb(tenantId, access_token, expiryDate);
  } catch (err) {
    const { message } = extractErrorDetails(err);
    log.warn({ tenantId, error: message }, 'Failed to update Twitch token in database');
  }

  return access_token;
}

export async function updateTwitchTokenInDb(tenantId: string, newToken: string, expiryDate: number): Promise<void> {
  const config = configService.get(tenantId);
  if (config?.twitch?.auth == null) {
    return;
  }

  try {
    const auth: TwitchAuth = decryptObject(config.twitch.auth);

    const updatedAuth = {
      client_id: auth.client_id,
      client_secret: auth.client_secret,
      access_token: newToken,
      expiry_date: expiryDate,
    };

    const encryptedAuth = encryptObject(updatedAuth);

    await getMetaClient()
      .updateTable('tenants')
      .set({ twitch: JSON.stringify({ ...config.twitch, auth: encryptedAuth }) })
      .where('id', '=', tenantId)
      .execute();

    configService.updateTwitchAuth(tenantId, encryptedAuth);

    log.info({ tenantId, expiry_date: expiryDate }, 'Updated Twitch token');
  } catch (err) {
    const { message } = extractErrorDetails(err);
    log.warn({ tenantId, error: message }, 'Failed to update Twitch token in database');
  }
}

export function getTwitchClient(tenantId: string): TwitchClient {
  return createTwitchClient(tenantId, () => getAppAccessToken(tenantId));
}
