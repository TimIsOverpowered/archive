import { getTwitchCredentials } from '../utils/credentials.js';
import { extractErrorDetails } from '../utils/error.js';
import { getTenantConfig, updateTenantTwitchAuth } from '../config/loader.js';
import { encryptObject, decryptObject } from '../utils/encryption.js';
import { metaClient } from '../db/meta-client.js';
import { childLogger } from '../utils/logger.js';
import { request } from '../utils/http-client.js';

const log = childLogger({ module: 'twitch-auth' });

interface TwitchAuth {
  client_id: string;
  client_secret: string;
  access_token?: string;
  expiry_date?: number;
}

export async function getAppAccessToken(tenantId: string): Promise<string> {
  const creds = getTwitchCredentials(tenantId);
  if (!creds) {
    throw new Error('Twitch credentials not configured');
  }

  if (creds.accessToken && creds.expiryDate) {
    const oneHourFromNow = Date.now() + 60 * 60 * 1000;

    if (creds.expiryDate > oneHourFromNow) {
      return creds.accessToken;
    }
  }

  const url = new URL('https://id.twitch.tv/oauth2/token');
  url.searchParams.append('client_id', creds.clientId);
  url.searchParams.append('client_secret', creds.clientSecret);
  url.searchParams.append('grant_type', 'client_credentials');

  const data = await request<{ access_token: string; expires_in: number }>(url.toString(), {
    method: 'POST',
  });

  const { access_token, expires_in } = data;
  const expiryDate = Date.now() + expires_in * 1000;

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
  const config = getTenantConfig(tenantId);
  if (!config?.twitch?.auth) {
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

    await metaClient.tenant.update({
      where: { id: tenantId },
      data: {
        twitch: {
          ...config.twitch,
          auth: encryptedAuth,
        },
      },
    });

    updateTenantTwitchAuth(tenantId, encryptedAuth);

    log.info({ tenantId, expiry_date: expiryDate }, 'Updated Twitch token');
  } catch (err) {
    const { message } = extractErrorDetails(err);
    log.warn({ tenantId, error: message }, 'Failed to update Twitch token in database');
  }
}
