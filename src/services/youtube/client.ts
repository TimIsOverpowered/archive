import { google } from 'googleapis';
import type { youtube_v3 } from 'googleapis';
import { getYoutubeAuth, REDIRECT_URI } from './auth.js';

export async function createYoutubeClient(tenantId: string): Promise<youtube_v3.Youtube> {
  const auth = await getYoutubeAuth(tenantId);

  const oauth2Client = new google.auth.OAuth2(auth.clientId, auth.clientSecret, REDIRECT_URI);
  oauth2Client.setCredentials({ access_token: auth.accessToken });

  return google.youtube({ version: 'v3', auth: oauth2Client });
}

export type YoutubeClient = ReturnType<typeof createYoutubeClient>;
