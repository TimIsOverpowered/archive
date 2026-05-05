import { Twitch } from '../../constants.js';
import { getTwitchAppCredentials } from '../../utils/credentials.js';
import { request } from '../../utils/http-client.js';
import { getLogger } from '../../utils/logger.js';

export interface TwitchClient {
  helix: {
    get: <T = unknown>(endpoint: string, logContext?: Record<string, unknown>) => Promise<T>;
    post: <T = unknown>(endpoint: string, body?: object, logContext?: Record<string, unknown>) => Promise<T>;
  };
}

export function createTwitchClient(getAccessToken: () => Promise<string>): TwitchClient {
  const { clientId } = getTwitchAppCredentials();

  return {
    helix: {
      async get<T = unknown>(endpoint: string, logContext?: Record<string, unknown>): Promise<T> {
        const accessToken = await getAccessToken();
        return request<T>(`${Twitch.HELIX_BASE_URL}${endpoint}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Client-Id': clientId,
          },
          logContext,
        });
      },
      async post<T = unknown>(endpoint: string, body?: object, logContext?: Record<string, unknown>): Promise<T> {
        const accessToken = await getAccessToken();
        return request<T>(`${Twitch.HELIX_BASE_URL}${endpoint}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Client-Id': clientId,
          },
          body,
          logContext,
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
