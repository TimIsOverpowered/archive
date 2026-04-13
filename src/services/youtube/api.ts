import { google } from 'googleapis';

export function createYoutubeClient(accessToken: string) {
  const authClient = new google.auth.OAuth2('', '', 'https://developers.google.com/oauthplayground');
  authClient.setCredentials({ access_token: accessToken });

  return google.youtube({ version: 'v3', auth: authClient });
}

export type YoutubeClient = ReturnType<typeof createYoutubeClient>;
