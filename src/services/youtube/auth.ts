import { google } from 'googleapis';
import { getTenantConfig, updateTenantYoutubeAuth } from '../../config/loader.js';
import { encryptObject } from '../../utils/encryption.js';
import { getMetaClient } from '../../db/meta-client.js';
import { extractErrorDetails } from '../../utils/error.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { getWorkersConfig } from '../../config/env.js';

interface AuthObject {
  access_token?: string;
  refresh_token: string;
  expiry_date: number;
  scope?: string;
  token_type?: string;
}

const REDIRECT_URI = 'https://developers.google.com/oauthplayground';

const { YOUTUBE_CLIENT_ID: clientId, YOUTUBE_CLIENT_SECRET: clientSecret } = getWorkersConfig();

async function updateYoutubeTokenInDb(
  tenantId: string,
  newAccessToken: string,
  newExpiryDate: number,
  refreshToken: string
): Promise<void> {
  const logger = createAutoLogger('youtube-auth');
  const config = getTenantConfig(tenantId);
  if (!config?.youtube?.auth) {
    return;
  }

  try {
    const updatedAuth: AuthObject = {
      access_token: newAccessToken,
      refresh_token: refreshToken,
      expiry_date: newExpiryDate,
    };

    const encryptedAuth = encryptObject(updatedAuth);

    await getMetaClient()
      .updateTable('tenants')
      .set({ youtube: JSON.stringify({ ...config.youtube, auth: encryptedAuth }) })
      .where('id', '=', tenantId)
      .execute();

    updateTenantYoutubeAuth(tenantId, encryptedAuth);

    logger.info({ tenantId }, 'Updated YouTube token in database');
  } catch (err) {
    const { message } = extractErrorDetails(err);
    logger.warn({ tenantId, error: message }, 'Failed to update YouTube token in database');
  }
}

async function refreshToken(
  tenantId: string,
  refreshToken: string,
  accessToken?: string
): Promise<{
  accessToken: string;
  expiryDate: number;
  refreshToken: string;
}> {
  const logger = createAutoLogger('youtube-auth');

  logger.info({ tenantId }, 'YouTube token expired or missing, refreshing');

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
  oauth2Client.setCredentials({
    refresh_token: refreshToken,
    access_token: accessToken || null,
  });

  try {
    const { credentials } = await oauth2Client.refreshAccessToken();

    if (!credentials.access_token || !credentials.expiry_date) {
      throw new Error('Token refresh failed - no access token or expiry returned');
    }

    if (credentials.refresh_token) {
      try {
        await updateYoutubeTokenInDb(
          tenantId,
          credentials.access_token,
          credentials.expiry_date,
          credentials.refresh_token
        );
      } catch (err) {
        const { message } = extractErrorDetails(err);
        logger.warn({ tenantId, error: message }, 'Failed to update YouTube token in database');
      }
    }

    logger.info({ tenantId, expiry_date: credentials.expiry_date }, 'YouTube token refreshed');

    return {
      accessToken: credentials.access_token,
      expiryDate: credentials.expiry_date,
      refreshToken: credentials.refresh_token || refreshToken,
    };
  } catch (error: unknown) {
    const details = extractErrorDetails(error);

    if (details.message.includes('invalid_grant') || details.message.includes('token_expired')) {
      throw new Error(
        `YouTube token refresh failed for ${tenantId} - re-authentication required. Original error: ${details.message}`
      );
    }

    throw error;
  }
}

export async function getYoutubeAuth(tenantId: string): Promise<{
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken: string;
}> {
  const logger = createAutoLogger('youtube-auth');
  const config = getTenantConfig(tenantId);

  if (!config?.youtube?.auth) {
    throw new Error(`YouTube auth not configured for ${tenantId}`);
  }

  const authObj = JSON.parse(config.youtube.auth) as AuthObject;

  if (!authObj.refresh_token || typeof authObj.refresh_token !== 'string' || !authObj.refresh_token.trim()) {
    throw new Error(`YouTube refresh token not configured for ${tenantId}`);
  }

  if (authObj.access_token && authObj.expiry_date && authObj.expiry_date > Date.now() + 60_000) {
    logger.info({ tenantId }, 'Using cached YouTube access token');
    return {
      clientId,
      clientSecret,
      refreshToken: authObj.refresh_token,
      accessToken: authObj.access_token,
    };
  }

  const refreshed = await refreshToken(tenantId, authObj.refresh_token, authObj.access_token);

  return {
    clientId,
    clientSecret,
    refreshToken: refreshed.refreshToken,
    accessToken: refreshed.accessToken,
  };
}

export { updateYoutubeTokenInDb, REDIRECT_URI };
export type { AuthObject };
