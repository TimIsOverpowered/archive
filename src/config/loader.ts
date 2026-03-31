import { metaClient } from '../db/meta-client';
import { decryptScalar } from '../utils/encryption';
import { normalizePath } from '../utils/path';
import { StreamerConfig } from './types';

const configCache = new Map<string, StreamerConfig>();

export async function loadStreamerConfigs(): Promise<StreamerConfig[]> {
  const tenants = await metaClient.tenant.findMany();
  if (tenants.length === 0) return [];

  for (const tenant of tenants) {
    if (!tenant.databaseUrl) continue;

    const dbUrl = decryptScalar(tenant.databaseUrl);

    const settingsObj: Record<string, unknown> = tenant.settings && typeof tenant.settings === 'object' && !Array.isArray(tenant.settings) ? (tenant.settings as Record<string, unknown>) : {};

    const streamerConfig: StreamerConfig = {
      id: tenant.id,
      displayName: tenant.displayName,
      database: { url: dbUrl },
      settings: {
        domainName: typeof settingsObj.domainName === 'string' ? settingsObj.domainName : '',
        saveMP4: typeof settingsObj.saveMP4 === 'boolean' ? settingsObj.saveMP4 : false,
        saveHLS: typeof settingsObj.saveHLS === 'boolean' ? settingsObj.saveHLS : false,
        timezone: typeof settingsObj.timezone === 'string' ? settingsObj.timezone : '',
        vodDownload: typeof settingsObj.vodDownload === 'boolean' ? settingsObj.vodDownload : true,
        chatDownload: typeof settingsObj.chatDownload === 'boolean' ? settingsObj.chatDownload : true,
      },
    };

    if ('vodPath' in settingsObj && settingsObj.vodPath) {
      streamerConfig.settings.vodPath = normalizePath(settingsObj.vodPath as string);
    }

    if ('livePath' in settingsObj && settingsObj.livePath) {
      streamerConfig.settings.livePath = normalizePath(settingsObj.livePath as string);
    }

    // Validate required fields in settings
    if (!streamerConfig.settings.domainName || !streamerConfig.settings.timezone) {
      throw new Error(`Tenant ${tenant.id}: Missing required settings. domainName=${!!streamerConfig.settings.domainName}, timezone=${!!streamerConfig.settings.timezone}`);
    }

    if (tenant.twitch && typeof tenant.twitch === 'object') {
      const twitch = tenant.twitch as Record<string, unknown>;

      streamerConfig.twitch = { enabled: false };

      if ('auth' in twitch && twitch.auth) {
        // Store encrypted auth object directly - will be decrypted when needed by services
        streamerConfig.twitch.auth = twitch.auth as string;
      }

      if ('username' in twitch && twitch.username) {
        streamerConfig.twitch.username = twitch.username as string;
      }

      if ('id' in twitch && twitch.id) {
        streamerConfig.twitch.id = String(twitch.id);
      }

      streamerConfig.twitch.enabled = (twitch.enabled ?? false) as boolean;
      streamerConfig.twitch.mainPlatform = (twitch.mainPlatform ?? false) as boolean;
    }

    if (tenant.youtube && typeof tenant.youtube === 'object') {
      const youtube = tenant.youtube as Record<string, unknown>;

      streamerConfig.youtube = {
        public: true,
        upload: true,
        vodUpload: true,
        liveUpload: true,
        multiTrack: false,
        splitDuration: 10800,
        perGameUpload: false,
        restrictedGames: [],
        description: '',
      };

      // Store encrypted auth string directly - decrypt on-demand in youtube service
      if ('auth' in youtube && youtube.auth) {
        streamerConfig.youtube.auth = youtube.auth as string;
      }

      // apiKey is stored separately (not inside auth object)
      if ('apiKey' in youtube && youtube.apiKey) {
        const apiKey = decryptScalar(youtube.apiKey as string);
        streamerConfig.youtube.apiKey = apiKey;
      }

      const youtubeSettings: Record<string, unknown> = (settingsObj.youtube && typeof settingsObj.youtube === 'object' ? settingsObj.youtube : {}) as Record<string, unknown>;

      streamerConfig.youtube.public = (youtubeSettings.public ?? true) as boolean;
      streamerConfig.youtube.splitDuration = (youtubeSettings.splitDuration ?? 10800) as number;
      streamerConfig.youtube.perGameUpload = (youtubeSettings.perGameUpload ?? false) as boolean;
      streamerConfig.youtube.restrictedGames = Array.isArray(youtubeSettings.restrictedGames) ? youtubeSettings.restrictedGames : [];
      streamerConfig.youtube.description = typeof youtubeSettings.description === 'string' ? youtubeSettings.description : '';
    }

    if (tenant.kick && typeof tenant.kick === 'object') {
      const kick = tenant.kick as Record<string, unknown>;

      streamerConfig.kick = { enabled: false };

      if ('username' in kick && kick.username) {
        streamerConfig.kick.username = kick.username as string;
      }

      streamerConfig.kick.enabled = (kick.enabled ?? false) as boolean;
      streamerConfig.kick.mainPlatform = (kick.mainPlatform ?? false) as boolean;
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

export function getConfigs(): Array<{ id: string }> {
  return Array.from(configCache.values());
}

export function getTenantDisplayName(tenantId: string): string {
  const config = configCache.get(tenantId);
  return config?.displayName || tenantId; // fallback to ID if somehow not found
}
