import { request } from '../../utils/http-client.js';
import { getTwitchCredentials } from '../../utils/credentials.js';
import { getLogger } from '../../utils/logger.js';
import { Twitch } from '../../constants.js';
import { ConfigNotConfiguredError } from '../../utils/domain-errors.js';

export interface TwitchClient {
  helix: {
    get: <T = unknown>(endpoint: string) => Promise<T>;
    post: <T = unknown>(endpoint: string, body?: object) => Promise<T>;
  };
}

export function createTwitchClient(tenantId: string, getAccessToken: () => Promise<string>): TwitchClient {
  const creds = getTwitchCredentials(tenantId);

  if (!creds) {
    throw new ConfigNotConfiguredError(`Twitch credentials for tenant ${tenantId}`);
  }

  return {
    helix: {
      async get<T = unknown>(endpoint: string): Promise<T> {
        const accessToken = await getAccessToken();
        return request<T>(`${Twitch.HELIX_BASE_URL}${endpoint}`, {
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
        return request<T>(`${Twitch.HELIX_BASE_URL}${endpoint}`, {
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
  const actualClientId = clientId ?? Twitch.GQL_CLIENT_ID;

  return {
    async post<T = unknown>(body: object): Promise<T> {
      const result = await request<T>(Twitch.GQL_URL, {
        method: 'POST',
        headers: {
          Accept: '*/*',
          'Client-Id': actualClientId,
          'Content-Type': 'text/plain;charset=UTF-8',
        },
        body,
        timeoutMs: 10000,
        logContext: tenantId != null ? { tenantId } : undefined,
      });

      if (result != null && typeof result === 'object' && 'errors' in result) {
        const errors = (result as Record<string, unknown>).errors;
        if (Array.isArray(errors) && errors.length > 0) {
          getLogger().error(
            {
              tenantId,
              errors,
              operationName: (body as Record<string, unknown>)?.operationName,
            },
            'API returned errors'
          );
        }
      }

      return result;
    },
  };
}
