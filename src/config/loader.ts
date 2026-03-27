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
      timezone: 'America/Chicago',
      alerts: { enabled: true },
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

    const settingsObj: Record<string, unknown> = tenant.settings && typeof tenant.settings === 'object' && !Array.isArray(tenant.settings) ? (tenant.settings as Record<string, unknown>) : {};

    if (tenant.youtube && typeof tenant.youtube === 'object') {
      const youtube = tenant.youtube as Record<string, unknown>;

      streamerConfig.youtube = {
        public: true,
        splitDuration: 10800,
        perGameUpload: false,
        restrictedGames: [],
        description: '',
        saveMP4: false,
        saveHLS: false,
      };

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

      const youtubeSettings: Record<string, unknown> =
        settingsObj.youtube && typeof settingsObj.youtube === 'object' && !Array.isArray(settingsObj.youtube) ? (settingsObj.youtube as Record<string, unknown>) : {};

      streamerConfig.youtube.public = (youtubeSettings.public ?? true) as boolean;
      streamerConfig.youtube.splitDuration = (youtubeSettings.splitDuration ?? 10800) as number;
      streamerConfig.youtube.perGameUpload = (youtubeSettings.perGameUpload ?? false) as boolean;
      streamerConfig.youtube.restrictedGames = Array.isArray(youtubeSettings.restrictedGames) ? (youtubeSettings.restrictedGames as string[]) : [];
      streamerConfig.youtube.description = typeof youtubeSettings.description === 'string' ? youtubeSettings.description : '';
      streamerConfig.youtube.saveMP4 = (youtubeSettings.saveMP4 ?? false) as boolean;
      streamerConfig.youtube.saveHLS = (youtubeSettings.saveHLS ?? false) as boolean;
    }

    if (tenant.kick && typeof tenant.kick === 'object') {
      const kick = tenant.kick as Record<string, unknown>;
      if ('username' in kick && kick.username) {
        streamerConfig.kick = { enabled: true };
        streamerConfig.kick.channelName = kick.username as string;
      }
    }

    const alertsSettings: Record<string, unknown> =
      settingsObj.alerts && typeof settingsObj.alerts === 'object' && !Array.isArray(settingsObj.alerts) ? (settingsObj.alerts as Record<string, unknown>) : {};
    streamerConfig.timezone = typeof settingsObj.timezone === 'string' ? settingsObj.timezone : 'America/Chicago';
    streamerConfig.alerts.enabled = (alertsSettings.enabled ?? true) as boolean;

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

export function getConfigs(): Array<{ id: string }> {
  return Array.from(configCache.values());
}
