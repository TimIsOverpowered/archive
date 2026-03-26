import { metaClient } from '../db/meta-client';
import { decryptObject, decryptScalar } from '../utils/encryption';
import { StreamerConfig } from './types';

const configCache = new Map<string, StreamerConfig>();

export async function loadStreamerConfigs(): Promise<StreamerConfig[]> {
  const tenants = await metaClient.tenant.findMany();
  if (tenants.length === 0) return [];

  for (const tenant of tenants) {
    if (!tenant.databaseUrl) continue;

    const dbUrl = decryptScalar(tenant.databaseUrl);

    const streamerConfig: StreamerConfig = {
      id: tenant.id,
      database: { url: dbUrl },
    };

    if (tenant.twitch && typeof tenant.twitch === 'object') {
      const twitch = tenant.twitch as Record<string, unknown>;
      if ('username' in twitch && twitch.username) {
        streamerConfig.twitch = {};

        if ('auth' in twitch && twitch.auth) {
          const auth = decryptObject<{ client_id: string; client_secret: string; access_token: string }>(twitch.auth as string);
          streamerConfig.twitch.clientId = auth.client_id;
          streamerConfig.twitch.clientSecret = auth.client_secret;
        }

        streamerConfig.twitch.channelName = twitch.username as string;
      }
    }

    if (tenant.youtube && typeof tenant.youtube === 'object') {
      const youtube = tenant.youtube as Record<string, unknown>;

      streamerConfig.youtube = {};

      if ('api_key' in youtube && youtube.api_key) {
        const apiKey = decryptScalar(youtube.api_key as string);
        streamerConfig.youtube.clientId = apiKey;
      }

      if ('auth' in youtube && youtube.auth) {
        const auth = decryptObject<{ access_token: string; refresh_token: string; scope: string; token_type: string; expires_in: number }>(youtube.auth as string);
        streamerConfig.youtube.refreshToken = auth.refresh_token;
      }

      if ('client_secret' in youtube && youtube.client_secret) {
        const clientSecret = decryptScalar(youtube.client_secret as string);
        streamerConfig.youtube.clientSecret = clientSecret;
      }
    }

    if (tenant.kick && typeof tenant.kick === 'object') {
      const kick = tenant.kick as Record<string, unknown>;
      if ('username' in kick && kick.username) {
        streamerConfig.kick = { enabled: true };
        streamerConfig.kick.channelName = kick.username as string;
      }
    }

    configCache.set(streamerConfig.id, streamerConfig);
  }

  return Array.from(configCache.values());
}

export function getStreamerConfig(streamerId: string): StreamerConfig | undefined {
  return configCache.get(streamerId);
}

export function getConfigById(streamerId: string): StreamerConfig | undefined {
  return getStreamerConfig(streamerId);
}

export function clearConfigCache(): void {
  configCache.clear();
}
