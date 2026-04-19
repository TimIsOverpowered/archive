import { initMetaClient, getMetaClient } from '../db/meta-client.js';
import { decryptScalar } from '../utils/encryption.js';
import { SettingsSchema, YoutubeSchema, TwitchSchema, KickSchema } from './schemas.js';
import { TenantConfig } from './types.js';
import { getConfigCacheTtl } from './env.js';
import type { JsonObject } from '@prisma/client/runtime/client';
import type { TenantModel } from '../../prisma/generated/meta/models/Tenant.js';

interface CachedEntry {
  config: TenantConfig;
  expiresAt: number;
}

const configCache = new Map<string, CachedEntry>();

function _now(): number {
  return Date.now();
}

function _buildTenantConfig(tenant: TenantModel): TenantConfig | null {
  if (!tenant.databaseUrl) return null;

  const dbUrl = decryptScalar(tenant.databaseUrl);

  const settingsObj: JsonObject =
    tenant.settings && typeof tenant.settings === 'object' && !Array.isArray(tenant.settings) ? tenant.settings : {};
  const settings = SettingsSchema.parse(settingsObj);

  if (!settings.domainName || !settings.timezone) {
    throw new Error(
      `Tenant ${tenant.id}: Missing required settings. domainName=${!!settings.domainName}, timezone=${!!settings.timezone}`
    );
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

  return tenantConfig;
}

export async function loadTenantConfigs(): Promise<TenantConfig[]> {
  await initMetaClient();
  const tenants = await getMetaClient().tenant.findMany();
  if (tenants.length === 0) return [];

  const ttl = getConfigCacheTtl() * 1000;

  for (const tenant of tenants) {
    const config = _buildTenantConfig(tenant);
    if (!config) continue;

    configCache.set(config.id, { config, expiresAt: _now() + ttl });
  }

  return Array.from(configCache.values()).map((e) => e.config);
}

export async function reloadTenantConfig(tenantId: string): Promise<TenantConfig | undefined> {
  await initMetaClient();
  const tenant = await getMetaClient().tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return undefined;

  const config = _buildTenantConfig(tenant);
  if (!config) return undefined;

  const ttl = getConfigCacheTtl() * 1000;
  configCache.set(config.id, { config, expiresAt: _now() + ttl });
  return config;
}

export function getTenantConfig(tenantId: string): TenantConfig | undefined {
  const entry = configCache.get(tenantId);
  if (!entry) return undefined;
  if (_now() > entry.expiresAt) {
    configCache.delete(tenantId);
    return undefined;
  }
  return entry.config;
}

export function clearConfigCache(tenantId?: string): void {
  if (tenantId) {
    configCache.delete(tenantId);
  } else {
    configCache.clear();
  }
}

export function getConfigs(): TenantConfig[] {
  return Array.from(configCache.values()).map((e) => e.config);
}

export function getTenantDisplayName(tenantId: string): string {
  const config = getTenantConfig(tenantId);
  return config?.displayName || tenantId;
}

export function updateTenantTwitchAuth(tenantId: string, encryptedAuth: string): void {
  const entry = configCache.get(tenantId);
  if (!entry?.config?.twitch?.auth) return;
  configCache.set(tenantId, {
    ...entry,
    config: { ...entry.config, twitch: { ...entry.config.twitch, auth: encryptedAuth } },
  });
}

export function updateTenantYoutubeAuth(tenantId: string, encryptedAuth: string): void {
  const entry = configCache.get(tenantId);
  if (!entry?.config?.youtube?.auth) return;
  configCache.set(tenantId, {
    ...entry,
    config: { ...entry.config, youtube: { ...entry.config.youtube, auth: encryptedAuth } },
  });
}
