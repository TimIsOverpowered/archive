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
  if (tenant.databaseUrl == null) return null;

  const dbUrl = decryptScalar(tenant.databaseUrl);

  const settingsObj: Record<string, unknown> =
    typeof tenant.settings === 'object' && tenant.settings !== null && !Array.isArray(tenant.settings)
      ? tenant.settings
      : {};
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
    if ('auth' in youtubeObj && typeof youtubeObj.auth === 'string' && youtubeObj.auth !== '') {
      youtubeObj.auth = decryptScalar(youtubeObj.auth);
    }
    if ('apiKey' in youtubeObj && typeof youtubeObj.apiKey === 'string' && youtubeObj.apiKey !== '') {
      youtubeObj.apiKey = decryptScalar(youtubeObj.apiKey);
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
  private cache: LRUCache<string, TenantConfig>;

  constructor(ttlSeconds: number = 3600) {
    this.cache = new LRUCache({
      max: 500,
      ttl: ttlSeconds * 1000,
      allowStale: false,
      updateAgeOnGet: true,
    });
  }

  async loadAll(): Promise<TenantConfig[]> {
    await initMetaClient();
    const tenants = await getAllTenants();
    if (tenants.length === 0) return [];

    for (const tenant of tenants) {
      const config = buildTenantConfig(tenant);
      if (!config) continue;
      this.cache.set(config.id, config);
    }

    return Array.from(this.cache.values());
  }

  get(tenantId: string): TenantConfig | undefined {
    return this.cache.get(tenantId);
  }

  getAll(): TenantConfig[] {
    return Array.from(this.cache.values());
  }

  /**
   * Clear the entire cache. Safe to call in production (e.g. on config change)
   * but primarily intended for test isolation.
   */
  reset(): void {
    this.cache.clear();
  }

  /**
   * @internal — test use only. Seeds the cache with pre-built tenant configs
   * without hitting the database.
   */
  seed(configs: TenantConfig[]): void {
    for (const config of configs) {
      this.cache.set(config.id, config);
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
    const config = this.cache.get(tenantId);
    if (config?.twitch?.auth == null) return;
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
    const config = this.cache.get(tenantId);
    if (config?.youtube?.auth == null) return;
    const decryptedAuth = decryptScalar(encryptedAuth);
    config.youtube.auth = decryptedAuth;
  }
}

export const configService = new ConfigService(getBaseConfig().CONFIG_CACHE_TTL);
