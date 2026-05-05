import { Twitch } from '../../constants.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { getTwitchAppCredentials } from '../../utils/credentials.js';
import { request } from '../../utils/http-client.js';
import { createTwitchClient, type TwitchClient } from './client.js';

const log = createAutoLogger('twitch-auth');

let tokenState: { token: string; expiresAt: number } | null = null;
let refreshing: Promise<string> | null = null;

export async function getAppAccessToken(): Promise<string> {
  const now = Date.now();

  if (tokenState != null && tokenState.expiresAt > now + 60 * 60 * 1000) {
    return tokenState.token;
  }

  if (refreshing != null) {
    return refreshing;
  }

  refreshing = refreshToken();
  try {
    const token = await refreshing;
    return token;
  } finally {
    refreshing = null;
  }
}

async function refreshToken(): Promise<string> {
  const { clientId, clientSecret } = getTwitchAppCredentials();

  const url = new URL(Twitch.TOKEN_URL);
  url.searchParams.append('client_id', clientId);
  url.searchParams.append('client_secret', clientSecret);
  url.searchParams.append('grant_type', 'client_credentials');

  const data = await request<{ access_token: string; expires_in: number }>(url.toString(), {
    method: 'POST',
  });

  const { access_token, expires_in } = data;
  const expiresAt = Date.now() + expires_in * 1000;

  tokenState = { token: access_token, expiresAt };

  log.info({ expires_in, expires_at: expiresAt }, 'Fetched new Twitch access token');

  return access_token;
}

export function getTwitchClient(): TwitchClient {
  return createTwitchClient(() => getAppAccessToken());
}
