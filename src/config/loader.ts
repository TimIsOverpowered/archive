import { LRUCache } from 'lru-cache';
import { initMetaClient } from '../db/meta-client.js';
import { getAllTenants, getTenantById } from '../services/meta-tenants.service.js';
import { decryptScalar } from '../utils/encryption.js';
import { SettingsSchema, YoutubeSchema, TwitchSchema, KickSchema } from './schemas.js';
import { TenantConfig } from './types.js';
import { getBaseConfig } from './env.js';
import type { TenantResult } from '../db/meta-types.js';
import { asJsonObject } from '../utils/object.js';

let configCache: LRUCache<string, TenantConfig> | null = null;

function createConfigCache(): LRUCache<string, TenantConfig> {
  const ttl = getBaseConfig().CONFIG_CACHE_TTL * 1000;
  return new LRUCache({
    max: 500,
    ttl,
    allowStale: false,
    updateAgeOnGet: true,
  });
}

function getCache(): LRUCache<string, TenantConfig> {
  if (!configCache) {
    configCache = createConfigCache();
  }
  return configCache;
}

function buildTenantConfig(tenant: TenantResult): TenantConfig | null {
  if (!tenant.databaseUrl) return null;

  const dbUrl = decryptScalar(tenant.databaseUrl);

  const settingsObj: Record<string, unknown> =
    tenant.settings && typeof tenant.settings === 'object' && !Array.isArray(tenant.settings) ? tenant.settings : {};
  const settings = SettingsSchema.parse(settingsObj);

  const tenantConfig: TenantConfig = {
    id: tenant.id,
    displayName: tenant.displayName ?? undefined,
    createdAt: tenant.createdAt,
    database: { url: dbUrl },
    settings,
  };

  const twitchObj = asJsonObject(tenant.twitch);
  if (twitchObj) {
    tenantConfig.twitch = TwitchSchema.parse(twitchObj);
  }

  const youtubeObj = asJsonObject(tenant.youtube);
  if (youtubeObj) {
    if ('auth' in youtubeObj && youtubeObj.auth) {
      youtubeObj.auth = decryptScalar(youtubeObj.auth as string);
    }
    if ('apiKey' in youtubeObj && youtubeObj.apiKey) {
      youtubeObj.apiKey = decryptScalar(youtubeObj.apiKey as string);
    }
    tenantConfig.youtube = YoutubeSchema.parse(youtubeObj);
  }

  const kickObj = asJsonObject(tenant.kick);
  if (kickObj) {
    tenantConfig.kick = KickSchema.parse(kickObj);
  }

  return tenantConfig;
}

export async function loadTenantConfigs(): Promise<TenantConfig[]> {
  await initMetaClient();
  const tenants = await getAllTenants();
  if (tenants.length === 0) return [];

  const cache = getCache();
  for (const tenant of tenants) {
    const config = buildTenantConfig(tenant);
    if (!config) continue;
    cache.set(config.id, config);
  }

  return Array.from(cache.values());
}

export async function reloadTenantConfig(tenantId: string): Promise<TenantConfig | undefined> {
  await initMetaClient();
  const tenant = await getTenantById(tenantId);
  if (!tenant) return undefined;

  const config = buildTenantConfig(tenant);
  if (!config) return undefined;

  getCache().set(config.id, config);
  return config;
}

export function getTenantConfig(tenantId: string): TenantConfig | undefined {
  return getCache().get(tenantId);
}

export function clearConfigCache(tenantId?: string): void {
  if (tenantId) {
    getCache().delete(tenantId);
  } else {
    configCache = null;
  }
}

export function getConfigs(): TenantConfig[] {
  const cache = getCache();
  return Array.from(cache.values());
}

export function getTenantDisplayName(tenantId: string): string {
  const config = getTenantConfig(tenantId);
  return config?.displayName || tenantId;
}

export function updateTenantTwitchAuth(tenantId: string, encryptedAuth: string): void {
  const cache = getCache();
  const entry = cache.get(tenantId);
  if (!entry?.twitch?.auth) return;
  cache.set(tenantId, { ...entry, twitch: { ...entry.twitch, auth: encryptedAuth } });
}

export function updateTenantYoutubeAuth(tenantId: string, encryptedAuth: string): void {
  const cache = getCache();
  const entry = cache.get(tenantId);
  if (!entry?.youtube?.auth) return;
  const decryptedAuth = decryptScalar(encryptedAuth);
  cache.set(tenantId, { ...entry, youtube: { ...entry.youtube, auth: decryptedAuth } });
}
