import { request } from '../../utils/http-client.js';
import { getTwitchCredentials } from '../../utils/credentials.js';
import { logger } from '../../utils/logger.js';

const TWITCH_GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
export const BACKUP_TWITCH_GQL_CLIENT_ID = 'kd1unb4b3q4t58fwlpcbzcbnm76a8fp';

export interface TwitchClient {
  helix: {
    get: <T = unknown>(endpoint: string) => Promise<T>;
    post: <T = unknown>(endpoint: string, body?: object) => Promise<T>;
  };
}

export function createTwitchClient(tenantId: string, getAccessToken: () => Promise<string>): TwitchClient {
  const creds = getTwitchCredentials(tenantId);

  if (!creds) {
    throw new Error(`Twitch credentials not configured for tenant ${tenantId}`);
  }

  return {
    helix: {
      async get<T = unknown>(endpoint: string): Promise<T> {
        const accessToken = await getAccessToken();
        return request<T>(`https://api.twitch.tv/helix${endpoint}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Client-Id': creds.clientId,
          },
          logContext: { tenantId },
        });
      },
      async post<T = unknown>(endpoint: string, body?: object): Promise<T> {
        const accessToken = await getAccessToken();
        return request<T>(`https://api.twitch.tv/helix${endpoint}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Client-Id': creds.clientId,
          },
          body,
          logContext: { tenantId },
        });
      },
    },
  };
}

export function createTwitchGqlClient(
  tenantId?: string,
  clientId?: string
): {
  post: <T = unknown>(body: object) => Promise<T>;
} {
  const actualClientId = clientId ?? TWITCH_GQL_CLIENT_ID;

  return {
    async post<T = unknown>(body: object): Promise<T> {
      const result = await request<T>('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: {
          Accept: '*/*',
          'Client-Id': actualClientId,
          'Content-Type': 'text/plain;charset=UTF-8',
        },
        body,
        timeoutMs: 10000,
        logContext: tenantId ? { tenantId } : undefined,
      });

      if (result && typeof result === 'object' && 'errors' in result) {
        const errors = (result as Record<string, unknown>).errors;
        if (Array.isArray(errors) && errors.length > 0) {
          logger.error(
            {
              tenantId,
              errors,
              operationName: (body as Record<string, unknown>)?.operationName,
            },
            '[Twitch GraphQL] API returned errors'
          );
        }
      }

      return result;
    },
  };
}
