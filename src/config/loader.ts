import { metaClient } from '../db/meta-client';
import { decryptScalar } from '../utils/encryption';
import { SettingsSchema, YoutubeSchema } from './schemas';
import { TenantConfig } from './types';
import type { JsonObject } from '@prisma/client/runtime/client';

export const configCache = new Map<string, TenantConfig>();

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
      const twitch = tenant.twitch as JsonObject;

      tenantConfig.twitch = { enabled: (twitch.enabled ?? false) as boolean };

      if ('auth' in twitch && twitch.auth) {
        tenantConfig.twitch.auth = twitch.auth as string;
      }

      if ('username' in twitch && twitch.username) {
        tenantConfig.twitch.username = twitch.username as string;
      }

      if ('id' in twitch && twitch.id) {
        tenantConfig.twitch.id = String(twitch.id);
      }

      tenantConfig.twitch.mainPlatform = (twitch.mainPlatform ?? false) as boolean;
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
      const kick = tenant.kick as JsonObject;

      tenantConfig.kick = { enabled: (kick.enabled ?? false) as boolean };

      if ('id' in kick && kick.id) {
        tenantConfig.kick.id = kick.id as string;
      }

      if ('username' in kick && kick.username) {
        tenantConfig.kick.username = kick.username as string;
      }

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
