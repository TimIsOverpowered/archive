import { metaClient } from '../db/meta-client';
import { decryptScalar } from '../utils/encryption';
import { normalizePath } from '../utils/path';
import { TenantConfig } from './types';

const configCache = new Map<string, TenantConfig>();

// Default configuration constants
const DEFAULT_YOUTUBE_SPLIT_DURATION = 10800; // 3 hours in seconds

export async function loadTenantConfigs(): Promise<TenantConfig[]> {
  const tenants = await metaClient.tenant.findMany();
  if (tenants.length === 0) return [];

  for (const tenant of tenants) {
    if (!tenant.databaseUrl) continue;

    const dbUrl = decryptScalar(tenant.databaseUrl);

    const settingsObj: Record<string, unknown> = tenant.settings && typeof tenant.settings === 'object' && !Array.isArray(tenant.settings) ? (tenant.settings as Record<string, unknown>) : {};

    const tenantConfig: TenantConfig = {
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
        hlsDownloadConcurrency: typeof settingsObj.hlsDownloadConcurrency === 'number' ? settingsObj.hlsDownloadConcurrency : 10,
        hlsDownloadRetryAttempts: typeof settingsObj.hlsDownloadRetryAttempts === 'number' ? settingsObj.hlsDownloadRetryAttempts : 3,
      },
    };

    if ('vodPath' in settingsObj && settingsObj.vodPath) {
      tenantConfig.settings.vodPath = normalizePath(settingsObj.vodPath as string);
    }

    if ('livePath' in settingsObj && settingsObj.livePath) {
      tenantConfig.settings.livePath = normalizePath(settingsObj.livePath as string);
    }

    // Validate required fields in settings
    if (!tenantConfig.settings.domainName || !tenantConfig.settings.timezone) {
      throw new Error(`Tenant ${tenant.id}: Missing required settings. domainName=${!!tenantConfig.settings.domainName}, timezone=${!!tenantConfig.settings.timezone}`);
    }

    if (tenant.twitch && typeof tenant.twitch === 'object') {
      const twitch = tenant.twitch as Record<string, unknown>;

      tenantConfig.twitch = { enabled: false };

      if ('auth' in twitch && twitch.auth) {
        // Store encrypted auth object directly - will be decrypted when needed by services
        tenantConfig.twitch.auth = twitch.auth as string;
      }

      if ('username' in twitch && twitch.username) {
        tenantConfig.twitch.username = twitch.username as string;
      }

      if ('id' in twitch && twitch.id) {
        tenantConfig.twitch.id = String(twitch.id);
      }

      tenantConfig.twitch.enabled = (twitch.enabled ?? false) as boolean;
      tenantConfig.twitch.mainPlatform = (twitch.mainPlatform ?? false) as boolean;
    }

    if (tenant.youtube && typeof tenant.youtube === 'object') {
      const youtube = tenant.youtube as Record<string, unknown>;

      tenantConfig.youtube = {
        public: true,
        upload: true,
        vodUpload: true,
        liveUpload: true,
        multiTrack: false,
        splitDuration: DEFAULT_YOUTUBE_SPLIT_DURATION,
        perGameUpload: false,
        restrictedGames: [],
        description: '',
      };

      // Store encrypted auth string directly - decrypt on-demand in youtube service
      if ('auth' in youtube && youtube.auth) {
        tenantConfig.youtube.auth = youtube.auth as string;
      }

      // apiKey is stored separately (not inside auth object)
      if ('apiKey' in youtube && youtube.apiKey) {
        const apiKey = decryptScalar(youtube.apiKey as string);
        tenantConfig.youtube.apiKey = apiKey;
      }

      const youtubeSettings: Record<string, unknown> = (settingsObj.youtube && typeof settingsObj.youtube === 'object' ? settingsObj.youtube : {}) as Record<string, unknown>;

      tenantConfig.youtube.public = (youtubeSettings.public ?? true) as boolean;
      tenantConfig.youtube.splitDuration = (youtubeSettings.splitDuration ?? DEFAULT_YOUTUBE_SPLIT_DURATION) as number;
      tenantConfig.youtube.perGameUpload = (youtubeSettings.perGameUpload ?? false) as boolean;
      tenantConfig.youtube.restrictedGames = Array.isArray(youtubeSettings.restrictedGames) ? youtubeSettings.restrictedGames : [];
      tenantConfig.youtube.description = typeof youtubeSettings.description === 'string' ? youtubeSettings.description : '';
    }

    if (tenant.kick && typeof tenant.kick === 'object') {
      const kick = tenant.kick as Record<string, unknown>;

      tenantConfig.kick = { enabled: false };

      if ('id' in kick && kick.id) {
        tenantConfig.kick.id = kick.id as string;
      }

      if ('username' in kick && kick.username) {
        tenantConfig.kick.username = kick.username as string;
      }

      tenantConfig.kick.enabled = (kick.enabled ?? false) as boolean;
      tenantConfig.kick.mainPlatform = (kick.mainPlatform ?? false) as boolean;
    }

    configCache.set(tenantConfig.id, tenantConfig);
  }

  return Array.from(configCache.values());
}

export function getTenantConfig(tenantId: string): TenantConfig | undefined {
  return configCache.get(tenantId);
}

export function clearConfigCache(): void {
  configCache.clear();
}

export function getConfigs(): TenantConfig[] {
  return Array.from(configCache.values());
}

export function getTenantDisplayName(tenantId: string): string {
  const config = configCache.get(tenantId);
  return config?.displayName || tenantId; // fallback to ID if somehow not found
}
