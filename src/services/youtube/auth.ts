import { google } from 'googleapis';
import { getWorkersConfig } from '../../config/env.js';
import type { YoutubeAuthObject } from '../../config/schemas.js';
import { configService } from '../../config/tenant-config.js';
import { getMetaClient } from '../../db/meta-client.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { ConfigNotConfiguredError } from '../../utils/domain-errors.js';
import { encryptObject, encryptScalar } from '../../utils/encryption.js';
import { extractErrorDetails } from '../../utils/error.js';

const REDIRECT_URI = 'https://developers.google.com/oauthplayground';

const { YOUTUBE_CLIENT_ID: clientId, YOUTUBE_CLIENT_SECRET: clientSecret } = getWorkersConfig();

async function updateYoutubeTokenInDb(
  tenantId: string,
  newAccessToken: string,
  newExpiryDate: number,
  refreshToken: string
): Promise<void> {
  const logger = createAutoLogger('youtube-auth');
  const config = await configService.get(tenantId);
  if (config?.youtube?.auth == null) {
    return;
  }

  try {
    const updatedAuth: YoutubeAuthObject = {
      access_token: newAccessToken,
      refresh_token: refreshToken,
      expiry_date: newExpiryDate,
    };

    const encryptedAuth = encryptObject(updatedAuth);
    const encryptedApiKey =
      config.youtube.apiKey != null && config.youtube.apiKey !== '' ? encryptScalar(config.youtube.apiKey) : undefined;

    await getMetaClient()
      .updateTable('tenants')
      .set({ youtube: JSON.stringify({ ...config.youtube, auth: encryptedAuth, apiKey: encryptedApiKey }) })
      .where('id', '=', tenantId)
      .execute();

    configService.updateYoutubeAuth(tenantId, updatedAuth);
    configService.publishConfigChanged(tenantId);

    logger.info({ tenantId }, 'Updated YouTube token in database');
  } catch (err) {
    const { message } = extractErrorDetails(err);
    logger.warn({ tenantId, error: message }, 'Failed to update YouTube token in database');
  }
}

async function refreshToken(
  tenantId: string,
  refreshTokenVal: string,
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
    refresh_token: refreshTokenVal,
    access_token: accessToken ?? null,
  });

  try {
    const { credentials } = await oauth2Client.refreshAccessToken();

    if (credentials.access_token == null || credentials.expiry_date == null) {
      throw new Error('Token refresh failed - no access token or expiry returned');
    }

    if (credentials.refresh_token != null && credentials.refresh_token !== '') {
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
      refreshToken: credentials.refresh_token ?? refreshTokenVal,
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
  const config = await configService.get(tenantId);

  if (config?.youtube?.auth == null) {
    throw new ConfigNotConfiguredError(`YouTube auth for ${tenantId}`);
  }

  const authObj = config.youtube.auth;

  if (
    authObj.refresh_token == null ||
    typeof authObj.refresh_token !== 'string' ||
    authObj.refresh_token.trim() === ''
  ) {
    throw new ConfigNotConfiguredError(`YouTube refresh token for ${tenantId}`);
  }

  if (authObj.access_token != null && authObj.expiry_date != null && authObj.expiry_date > Date.now() + 60_000) {
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
