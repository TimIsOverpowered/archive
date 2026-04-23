import { LRUCache } from 'lru-cache';
import { initMetaClient } from '../db/meta-client.js';
import { getAllTenants } from '../services/meta-tenants.service.js';
import { decryptScalar } from '../utils/encryption.js';
import { SettingsSchema, YoutubeSchema, TwitchSchema, KickSchema } from './schemas.js';
import { TenantConfig } from './types.js';
import { getBaseConfig } from './env.js';
import type { TenantResult } from '../db/meta-types.js';
import { asJsonObject } from '../utils/object.js';

/**
 * Build a TenantConfig from a raw database tenant row.
 * Pure function — does not depend on any module-level state.
 */
export function buildTenantConfig(tenant: TenantResult): TenantConfig | null {
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

/**
 * Service that owns the in-memory tenant configuration cache (LRUCache).
 *
 * Pattern: module-level singleton instance (like WorkerRegistry).
 * Call configService.reset() in tests between cases.
 */
export class ConfigService {
  private cache: LRUCache<string, TenantConfig> | null = null;
  private ttl: number;

  constructor(ttlSeconds: number = 3600) {
    this.ttl = ttlSeconds * 1000;
  }

  private getCache(): LRUCache<string, TenantConfig> {
    if (!this.cache) {
      this.cache = new LRUCache({
        max: 500,
        ttl: this.ttl,
        allowStale: false,
        updateAgeOnGet: true,
      });
    }
    return this.cache;
  }

  async loadAll(): Promise<TenantConfig[]> {
    await initMetaClient();
    const tenants = await getAllTenants();
    if (tenants.length === 0) return [];

    const cache = this.getCache();
    for (const tenant of tenants) {
      const config = buildTenantConfig(tenant);
      if (!config) continue;
      cache.set(config.id, config);
    }

    return Array.from(cache.values());
  }

  get(tenantId: string): TenantConfig | undefined {
    return this.getCache().get(tenantId);
  }

  getAll(): TenantConfig[] {
    const cache = this.getCache();
    return Array.from(cache.values());
  }

  /**
   * Clear the entire cache. Safe to call in production (e.g. on config change)
   * but primarily intended for test isolation.
   */
  reset(): void {
    this.cache?.clear();
    this.cache = null;
  }

  /**
   * @internal — test use only. Seeds the cache with pre-built tenant configs
   * without hitting the database.
   */
  seed(configs: TenantConfig[]): void {
    const cache = this.getCache();
    for (const config of configs) {
      cache.set(config.id, config);
    }
  }

  /**
   * Mutates the cached config object in-place. LRUCache stores by reference,
   * so this does NOT create a new object — callers that hold a reference to
   * the config returned by .get() will see the auth field update.
   *
   * DO NOT replace this with a spread + set() unless you verify no external
   * code holds a reference to the cached TenantConfig.
   */
  updateTwitchAuth(tenantId: string, encryptedAuth: string): void {
    const config = this.getCache().get(tenantId);
    if (!config?.twitch?.auth) return;
    config.twitch.auth = encryptedAuth;
  }

  /**
   * Mutates the cached config object in-place. LRUCache stores by reference,
   * so this does NOT create a new object — callers that hold a reference to
   * the config returned by .get() will see the auth field update.
   *
   * DO NOT replace this with a spread + set() unless you verify no external
   * code holds a reference to the cached TenantConfig.
   */
  updateYoutubeAuth(tenantId: string, encryptedAuth: string): void {
    const config = this.getCache().get(tenantId);
    if (!config?.youtube?.auth) return;
    const decryptedAuth = decryptScalar(encryptedAuth);
    config.youtube.auth = decryptedAuth;
  }
}

export const configService = new ConfigService(getBaseConfig().CONFIG_CACHE_TTL);
