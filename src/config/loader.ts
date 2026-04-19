import { LRUCache } from 'lru-cache';
import { initMetaClient, getMetaClient } from '../db/meta-client.js';
import { decryptScalar } from '../utils/encryption.js';
import { SettingsSchema, YoutubeSchema, TwitchSchema, KickSchema } from './schemas.js';
import { TenantConfig } from './types.js';
import { getConfigCacheTtl } from './env.js';
import type { JsonObject } from '@prisma/client/runtime/client';
import type { TenantModel } from '../../prisma/generated/meta/models/Tenant.js';

let configCache: LRUCache<string, TenantConfig> | null = null;

function _createConfigCache(): LRUCache<string, TenantConfig> {
  const ttl = getConfigCacheTtl() * 1000;
  return new LRUCache({
    max: 500,
    ttl,
    allowStale: false,
    updateAgeOnGet: true,
    dispose: (_value, _key) => {
      // No cleanup needed — TenantConfig is just plain data
    },
  });
}

function _getCache(): LRUCache<string, TenantConfig> {
  if (!configCache) {
    configCache = _createConfigCache();
  }
  return configCache;
}

function _now(): number {
  return Date.now();
}

function asJsonObject(val: unknown): Record<string, unknown> | null {
  return val && typeof val === 'object' && !Array.isArray(val) ? (val as Record<string, unknown>) : null;
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

  const twitchObj = asJsonObject(tenant.twitch);
  if (twitchObj) {
    tenantConfig.twitch = TwitchSchema.parse(twitchObj);
  }

  const youtubeObj = asJsonObject(tenant.youtube);
  if (youtubeObj) {
    const youtubeParsed = YoutubeSchema.parse(youtubeObj);
    tenantConfig.youtube = youtubeParsed;
    if ('auth' in youtubeObj && youtubeObj.auth) {
      tenantConfig.youtube.auth = youtubeObj.auth as string;
    }
    if ('apiKey' in youtubeObj && youtubeObj.apiKey) {
      const apiKey = decryptScalar(youtubeObj.apiKey as string);
      tenantConfig.youtube.apiKey = apiKey;
    }
  }

  const kickObj = asJsonObject(tenant.kick);
  if (kickObj) {
    tenantConfig.kick = KickSchema.parse(kickObj);
  }

  return tenantConfig;
}

export async function loadTenantConfigs(): Promise<TenantConfig[]> {
  await initMetaClient();
  const tenants = await getMetaClient().tenant.findMany();
  if (tenants.length === 0) return [];

  const cache = _getCache();
  for (const tenant of tenants) {
    const config = _buildTenantConfig(tenant);
    if (!config) continue;
    cache.set(config.id, config);
  }

  return Array.from(cache.values());
}

export async function reloadTenantConfig(tenantId: string): Promise<TenantConfig | undefined> {
  await initMetaClient();
  const tenant = await getMetaClient().tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return undefined;

  const config = _buildTenantConfig(tenant);
  if (!config) return undefined;

  _getCache().set(config.id, config);
  return config;
}

export function getTenantConfig(tenantId: string): TenantConfig | undefined {
  return _getCache().get(tenantId);
}

export function clearConfigCache(tenantId?: string): void {
  if (tenantId) {
    _getCache().delete(tenantId);
  } else {
    configCache = null;
  }
}

export function getConfigs(): TenantConfig[] {
  const cache = _getCache();
  return Array.from(cache.values());
}

export function getTenantDisplayName(tenantId: string): string {
  const config = getTenantConfig(tenantId);
  return config?.displayName || tenantId;
}

export function updateTenantTwitchAuth(tenantId: string, encryptedAuth: string): void {
  const cache = _getCache();
  const entry = cache.get(tenantId);
  if (!entry?.twitch?.auth) return;
  cache.set(tenantId, { ...entry, twitch: { ...entry.twitch, auth: encryptedAuth } });
}

export function updateTenantYoutubeAuth(tenantId: string, encryptedAuth: string): void {
  const cache = _getCache();
  const entry = cache.get(tenantId);
  if (!entry?.youtube?.auth) return;
  cache.set(tenantId, { ...entry, youtube: { ...entry.youtube, auth: encryptedAuth } });
}
