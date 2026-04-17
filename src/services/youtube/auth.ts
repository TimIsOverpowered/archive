import { google } from 'googleapis';
import { getTenantConfig, updateTenantYoutubeAuth } from '../../config/loader.js';
import { decryptObject, encryptObject } from '../../utils/encryption.js';
import { metaClient } from '../../db/meta-client.js';
import { extractErrorDetails } from '../../utils/error.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';

interface AuthObject {
  access_token?: string;
  refresh_token: string;
  expiry_date: number;
  scope?: string;
  token_type?: string;
}

interface DecryptedYoutubeCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
}

const REDIRECT_URI = 'https://developers.google.com/oauthplayground';

function getYoutubeCredentials(tenantId: string): DecryptedYoutubeCreds | null {
  const logger = createAutoLogger('youtube-auth');
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    logger.error('[YouTube] YOUTUBE_CLIENT_ID or YOUTUBE_CLIENT_SECRET not set in .env');
    return null;
  }

  const config = getTenantConfig(tenantId);

  if (!config?.youtube?.auth) {
    logger.warn(`[YouTube] No auth configured`);
    return null;
  }

  try {
    const authObj = decryptObject<AuthObject>(config.youtube.auth);

    if (!authObj.refresh_token || typeof authObj.refresh_token !== 'string' || !authObj.refresh_token.trim()) {
      logger.warn(`[YouTube] No valid refresh token found`);
      return null;
    }

    const creds: DecryptedYoutubeCreds = {
      clientId,
      clientSecret,
      refreshToken: authObj.refresh_token.trim(),
    };

    if (authObj.access_token && typeof authObj.expiry_date === 'number') {
      const now = Date.now();

      if (now < authObj.expiry_date - 60_000) {
        creds.accessToken = authObj.access_token;

        logger.info(`[YouTube] Using cached access token, expires at ${new Date(authObj.expiry_date).toISOString()}`);
      } else {
        const timeUntilExpiry = authObj.expiry_date - now;

        if (timeUntilExpiry < 0) {
          logger.info(
            `[YouTube] Cached access token expired ${Math.abs(timeUntilExpiry / 1000).toFixed(0)}s ago, will refresh on next API call`
          );
        } else {
          logger.info(
            `[YouTube] Access token expiring in ${(timeUntilExpiry / 1000).toFixed(0)}s (<60s buffer), forcing refresh for safety`
          );
        }
      }
    } else if (authObj.access_token) {
      logger.warn(`[YouTube] Cached access token has no valid expiry_date field, skipping cache use`);
    }

    return creds;
  } catch (error: unknown) {
    const details = extractErrorDetails(error);

    logger.error(details, `Failed to decrypt YouTube credentials for ${tenantId}`);
    return null;
  }
}

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

    await metaClient.tenant.update({
      where: { id: tenantId },
      data: {
        youtube: {
          ...config.youtube,
          auth: encryptedAuth,
        },
      },
    });

    updateTenantYoutubeAuth(tenantId, encryptedAuth);

    logger.info({ tenantId }, 'Updated YouTube token in database');
  } catch (err) {
    const { message } = extractErrorDetails(err);
    logger.warn({ tenantId, error: message }, 'Failed to update YouTube token in database');
  }
}

async function refreshToken(
  tenantId: string,
  creds: DecryptedYoutubeCreds
): Promise<{
  accessToken: string;
  expiryDate: number;
  refreshToken: string;
}> {
  const logger = createAutoLogger('youtube-auth');

  logger.info({ tenantId }, 'YouTube token expired or missing, refreshing');

  const oauth2Client = new google.auth.OAuth2(creds.clientId, creds.clientSecret, REDIRECT_URI);
  oauth2Client.setCredentials({
    refresh_token: creds.refreshToken,
    access_token: creds.accessToken || null,
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
      refreshToken: credentials.refresh_token || creds.refreshToken,
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
  const creds = getYoutubeCredentials(tenantId);

  if (!creds) {
    throw new Error(`YouTube credentials not configured for ${tenantId}`);
  }

  if (creds.accessToken) {
    try {
      const config = getTenantConfig(tenantId);
      if (!config?.youtube?.auth) throw new Error('YouTube auth not configured');

      const authObj = decryptObject<AuthObject>(config.youtube.auth);
      const expiryDate = authObj.expiry_date;

      if (expiryDate && expiryDate > Date.now() + 60_000) {
        logger.info({ tenantId }, 'Using cached YouTube access token');
        return {
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          refreshToken: creds.refreshToken,
          accessToken: creds.accessToken,
        };
      }
    } catch {
      // Ignore - will refresh below
    }
  }

  const refreshed = await refreshToken(tenantId, creds);

  return {
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    refreshToken: refreshed.refreshToken,
    accessToken: refreshed.accessToken,
  };
}

export { getYoutubeCredentials, updateYoutubeTokenInDb, REDIRECT_URI };
export type { AuthObject, DecryptedYoutubeCreds };
