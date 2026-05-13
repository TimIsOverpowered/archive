import { LRUCache } from 'lru-cache';
import type { ZodType } from 'zod';
import { ConfigCache } from '../constants.js';
import { initMetaClient } from '../db/meta-client.js';
import type { SelectableTenants } from '../db/meta-types.js';
import { getAllTenants, getTenantById } from '../services/meta-tenants.service.js';
import { extractErrorDetails } from '../utils/error.js';
import { getLogger } from '../utils/logger.js';
import { asJsonObject } from '../utils/object.js';
import { RedisService } from '../utils/redis-service.js';
import { SettingsSchema, YoutubeSchema, TwitchSchema, KickSchema, type YoutubeAuthObject } from './schemas.js';
import { TenantConfig } from './types.js';

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

  getLogger().warn(
    { tenantId, platformName, errors: result.error.issues },
    'Invalid platform config, skipping platform'
  );
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
export function buildTenantConfig(tenant: SelectableTenants): TenantConfig | null {
  const displayName = tenant.display_name ?? undefined;
  const databaseName = tenant.database_name;

  if (databaseName == null) return null;

  const settingsObj: Record<string, unknown> =
    typeof tenant.settings === 'object' && tenant.settings !== null && !Array.isArray(tenant.settings)
      ? tenant.settings
      : {};
  const settings = SettingsSchema.parse(settingsObj);

  const tenantConfig: TenantConfig = {
    id: tenant.id,
    displayName,
    createdAt: tenant.created_at,
    database: { name: databaseName },
    settings,
  };

  const twitchConfig = parsePlatformConfig(tenant.id, tenant.twitch, TwitchSchema, 'Twitch');
  if (twitchConfig != null) {
    tenantConfig.twitch = twitchConfig;
  }

  const youtubeConfig = parsePlatformConfig(tenant.id, tenant.youtube, YoutubeSchema, 'YouTube');
  if (youtubeConfig != null) {
    tenantConfig.youtube = youtubeConfig;
  }

  const kickConfig = parsePlatformConfig(tenant.id, tenant.kick, KickSchema, 'Kick');
  if (kickConfig != null) {
    tenantConfig.kick = kickConfig;
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

  /**
   * Get tenant config, loading from database on cache miss.
   * Returns undefined if the tenant doesn't exist or the DB is unavailable.
   */
  async get(tenantId: string): Promise<TenantConfig | undefined> {
    const cached = this.cache.get(tenantId);
    if (cached) return cached;

    try {
      await this.reloadTenant(tenantId);
    } catch (err) {
      getLogger().warn(
        { tenantId, error: extractErrorDetails(err) },
        'Failed to load tenant config from database on cache miss'
      );
    }

    return this.cache.get(tenantId);
  }

  /**
   * Synchronous cache-only lookup. Returns undefined on cache miss.
   * Used by logging utilities where a DB round-trip is unnecessary.
   */
  getSync(tenantId: string): TenantConfig | undefined {
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
   * Replaces the cached config with an immutable update containing the decrypted YouTube auth object.
   * Creates a new config object so all callers get the updated version.
   * Publishes a config change event via Redis Pub/Sub to notify other processes.
   */
  updateYoutubeAuth(tenantId: string, auth: YoutubeAuthObject): void {
    const config = this.cache.get(tenantId);
    if (!config || !config.youtube) return;
    const updated = { ...config, youtube: { ...config.youtube, auth } };
    this.cache.set(tenantId, updated);
    this.publishConfigChanged(tenantId);
  }

  /**
   * Reload a single tenant from the database, replacing the cached entry.
   *
   * @param publish - Whether to emit a Redis pub/sub event after reloading.
   *   Set to `false` when triggered by that event to avoid fan-out loops.
   */
  async reloadTenant(tenantId: string, { publish = true }: { publish?: boolean } = {}): Promise<void> {
    initMetaClient();
    const tenant = await getTenantById(tenantId);
    if (!tenant) {
      this.cache.delete(tenantId);
      return;
    }
    const config = buildTenantConfig(tenant);
    if (config) {
      this.cache.set(config.id, config);
      if (publish) this.publishConfigChanged(tenantId);
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

export const configService = new ConfigService(ConfigCache.TTL);
