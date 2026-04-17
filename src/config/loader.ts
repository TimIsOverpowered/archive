import { metaClient } from '../db/meta-client.js';
import { decryptScalar } from '../utils/encryption.js';
import { SettingsSchema, YoutubeSchema, TwitchSchema, KickSchema } from './schemas.js';
import { TenantConfig } from './types.js';
import type { JsonObject } from '@prisma/client/runtime/client';

const configCache = new Map<string, TenantConfig>();

export async function loadTenantConfigs(): Promise<TenantConfig[]> {
  const tenants = await metaClient.tenant.findMany();
  if (tenants.length === 0) return [];

  for (const tenant of tenants) {
    if (!tenant.databaseUrl) continue;

    const dbUrl = decryptScalar(tenant.databaseUrl);

    const settingsObj: JsonObject = tenant.settings && typeof tenant.settings === 'object' && !Array.isArray(tenant.settings) ? tenant.settings : {};
    const settings = SettingsSchema.parse(settingsObj);

    if (!settings.domainName || !settings.timezone) {
      throw new Error(`Tenant ${tenant.id}: Missing required settings. domainName=${!!settings.domainName}, timezone=${!!settings.timezone}`);
    }

    const tenantConfig: TenantConfig = {
      id: tenant.id,
      displayName: tenant.displayName,
      createdAt: tenant.createdAt,
      database: { url: dbUrl },
      settings,
    };

    if (tenant.twitch && typeof tenant.twitch === 'object') {
      tenantConfig.twitch = TwitchSchema.parse(tenant.twitch);
    }

    if (tenant.youtube && typeof tenant.youtube === 'object') {
      const youtube = tenant.youtube as JsonObject;
      const youtubeParsed = YoutubeSchema.parse(youtube);

      tenantConfig.youtube = youtubeParsed;

      if ('auth' in youtube && youtube.auth) {
        tenantConfig.youtube.auth = youtube.auth as string;
      }

      if ('apiKey' in youtube && youtube.apiKey) {
        const apiKey = decryptScalar(youtube.apiKey as string);
        tenantConfig.youtube.apiKey = apiKey;
      }
    }

    if (tenant.kick && typeof tenant.kick === 'object') {
      tenantConfig.kick = KickSchema.parse(tenant.kick);
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

export function updateTenantTwitchAuth(tenantId: string, encryptedAuth: string): void {
  const config = configCache.get(tenantId);
  if (!config?.twitch?.auth) return;
  configCache.set(tenantId, {
    ...config,
    twitch: { ...config.twitch, auth: encryptedAuth },
  });
}

export function updateTenantYoutubeAuth(tenantId: string, encryptedAuth: string): void {
  const config = configCache.get(tenantId);
  if (!config?.youtube?.auth) return;
  configCache.set(tenantId, {
    ...config,
    youtube: { ...config.youtube, auth: encryptedAuth },
  });
}
