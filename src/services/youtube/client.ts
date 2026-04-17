import { google } from 'googleapis';
import type { youtube_v3 } from 'googleapis';
import { getYoutubeAuth, REDIRECT_URI, updateYoutubeTokenInDb } from './auth.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';

export async function createYoutubeClient(tenantId: string): Promise<youtube_v3.Youtube> {
  const logger = createAutoLogger('youtube-auth');
  const auth = await getYoutubeAuth(tenantId);

  const oauth2Client = new google.auth.OAuth2(auth.clientId, auth.clientSecret, REDIRECT_URI);
  oauth2Client.setCredentials({
    access_token: auth.accessToken,
    refresh_token: auth.refreshToken,
  });

  oauth2Client.on('tokens', async (credentials) => {
    if (credentials.refresh_token && credentials.access_token && credentials.expiry_date) {
      const expiryDate = new Date(credentials.expiry_date);
      logger.info(
        {
          tenantId,
          expiry_date: expiryDate.toISOString(),
          expiry_epoch: credentials.expiry_date,
        },
        'YouTube token auto-refreshed during api call'
      );
      await updateYoutubeTokenInDb(tenantId, credentials.access_token, credentials.expiry_date, credentials.refresh_token);
    }
  });

  return google.youtube({ version: 'v3', auth: oauth2Client });
}

export type YoutubeClient = ReturnType<typeof createYoutubeClient>;
