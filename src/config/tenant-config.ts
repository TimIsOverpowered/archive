import { LRUCache } from 'lru-cache';
import { initMetaClient } from '../db/meta-client.js';
import { getAllTenants, getTenantById } from '../services/meta-tenants.service.js';
import { decryptScalar } from '../utils/encryption.js';
import { RedisService } from '../utils/redis-service.js';
import { getLogger } from '../utils/logger.js';
import { extractErrorDetails } from '../utils/error.js';
import {
  SettingsSchema,
  YoutubeSchema,
  TwitchSchema,
  KickSchema,
  type TwitchAuthObject,
  type YoutubeAuthObject,
} from './schemas.js';
import { TenantConfig } from './types.js';
import { getBaseConfig } from './env.js';
import type { TenantResult } from '../db/meta-types.js';
import { asJsonObject } from '../utils/object.js';
import type { ZodType } from 'zod';

function parsePlatformConfig<T>(
  tenantId: string,
  raw: unknown,
  schema: ZodType<T>,
  platformName: string
): T | undefined {
  const obj = asJsonObject(raw);
  if (!obj) return undefined;

  const result = schema.safeParse(obj);
  if (result.success) return result.data;

  getLogger().warn({ tenantId, errors: result.error.issues }, `Invalid ${platformName} config, skipping platform`);
  return undefined;
}

const CONFIG_CHANNEL = 'cache:tenant';

interface ConfigChangeEvent {
  type: 'TENANT_CONFIG_CHANGED';
  tenantId: string;
}

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

  const twitch = parsePlatformConfig(tenant.id, tenant.twitch, TwitchSchema, 'Twitch');
  if (twitch != null) tenantConfig.twitch = twitch;

  const youtube = parsePlatformConfig(tenant.id, tenant.youtube, YoutubeSchema, 'YouTube');
  if (youtube != null) tenantConfig.youtube = youtube;

  const kick = parsePlatformConfig(tenant.id, tenant.kick, KickSchema, 'Kick');
  if (kick != null) tenantConfig.kick = kick;

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
    initMetaClient();
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
   * Mutates the cached config object in-place with a decrypted Twitch auth object.
   * LRUCache stores by reference, so this does NOT create a new object — callers
   * that hold a reference to the config returned by .get() will see the auth update.
   *
   * DO NOT replace this with a spread + set() unless you verify no external
   * code holds a reference to the cached TenantConfig.
   */
  updateTwitchAuth(tenantId: string, auth: TwitchAuthObject): void {
    const config = this.cache.get(tenantId);
    if (config?.twitch?.auth == null) return;
    config.twitch.auth = auth;
  }

  /**
   * Mutates the cached config object in-place with a decrypted YouTube auth object.
   * LRUCache stores by reference, so this does NOT create a new object — callers
   * that hold a reference to the config returned by .get() will see the auth update.
   *
   * DO NOT replace this with a spread + set() unless you verify no external
   * code holds a reference to the cached TenantConfig.
   */
  updateYoutubeAuth(tenantId: string, auth: YoutubeAuthObject): void {
    const config = this.cache.get(tenantId);
    if (config?.youtube?.auth == null) return;
    config.youtube.auth = auth;
  }

  /**
   * Reload a single tenant from the database, replacing the cached entry.
   * Used by the Redis Pub/Sub subscriber to keep cross-process caches in sync.
   */
  async reloadTenant(tenantId: string): Promise<void> {
    initMetaClient();
    const tenant = await getTenantById(tenantId);
    if (!tenant) {
      this.cache.delete(tenantId);
      return;
    }
    const config = buildTenantConfig(tenant);
    if (config) {
      this.cache.set(config.id, config);
    }
  }

  /**
   * Publish a tenant config change event on Redis so other processes reload.
   * Fire-and-forget — errors are logged but not thrown.
   */
  publishConfigChanged(tenantId: string): void {
    const client = RedisService.getActiveClient();
    if (!client) return;

    const event: ConfigChangeEvent = { type: 'TENANT_CONFIG_CHANGED', tenantId };

    void client.publish(CONFIG_CHANNEL, JSON.stringify(event)).catch((err) => {
      const details = extractErrorDetails(err);
      getLogger().warn({ err: details, tenantId }, 'Failed to publish tenant config change event');
    });
  }
}

export const configService = new ConfigService(getBaseConfig().CONFIG_CACHE_TTL);
