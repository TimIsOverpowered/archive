import type { FastifyInstance } from 'fastify';
import { Cache } from '../constants.ts';
import { defaultCacheContext } from '../utils/cache.ts';
import { simpleKeys, swrKeys } from '../utils/cache-keys.ts';
import { extractErrorDetails } from '../utils/error.ts';
import { getLogger } from '../utils/logger.ts';
import { RedisService } from '../utils/redis-service.ts';
import { createRedisSubscriber } from '../utils/redis-subscriber.ts';
import { invalidateGameTags, invalidateVodVolatileCache } from './cache-tags.ts';
import { invalidateVodStaticCache, setVodVolatileCache } from './vod-cache.ts';

const CACHE_CHANNEL = 'cache:vod';
const GAME_CACHE_CHANNEL = 'cache:game';

interface VodUpdateEvent {
  type: 'VOD_UPDATED' | 'VOD_DURATION_UPDATED';
  tenantId: string;
  dbId: number;
  duration?: number;
  is_live?: boolean;
}

interface GameUpdateEvent {
  type: 'GAME_UPDATED';
  tenantId: string;
}

/**
 * Handle a parsed cache event by updating volatile cache or invalidating static cache.
 * Fire-and-forget from the Redis message listener; errors are caught and logged.
 */
export async function handleCacheEvent(event: VodUpdateEvent): Promise<void> {
  if (event.type === 'VOD_DURATION_UPDATED' && event.duration !== undefined) {
    await setVodVolatileCache(
      event.tenantId,
      event.dbId,
      { duration: event.duration, is_live: event.is_live ?? false },
      Cache.VOD_VOLATILE_TTL
    );
  } else {
    await invalidateVodStaticCache(event.tenantId, event.dbId);
    await invalidateVodVolatileCache(event.tenantId, event.dbId);

    // Drop the tenant stats cache so the admin dashboard syncs immediately
    const client = RedisService.getActiveClient();
    if (client) {
      const statsKey = simpleKeys.stats(event.tenantId);
      await client.unlink(statsKey).catch(() => {});
      defaultCacheContext.invalidateKey(statsKey);
    }
  }
}

/**
 * Handle a game update event by invalidating all game cache keys for the tenant.
 */
export async function handleGameCacheEvent(event: GameUpdateEvent): Promise<void> {
  await invalidateGameTags(event.tenantId);

  // Drop the tenant stats cache so the admin dashboard syncs immediately
  const client = RedisService.getActiveClient();
  if (client) {
    const statsKey = simpleKeys.stats(event.tenantId);
    await client.unlink(statsKey).catch(() => {});
    defaultCacheContext.invalidateKey(statsKey);
  }
}

/**
 * Publish a VOD update event to Redis for cache invalidation.
 * Subscribers will invalidate the static cache for the VOD.
 */
export async function publishVodUpdate(tenantId: string, dbId: number): Promise<void> {
  const client = RedisService.getActiveClient();
  if (!client) return;

  const event: VodUpdateEvent = { type: 'VOD_UPDATED', tenantId, dbId };

  try {
    await client.publish(CACHE_CHANNEL, JSON.stringify(event));
  } catch (error) {
    const details = extractErrorDetails(error);
    getLogger().warn({ err: details, tenantId, dbId }, 'Failed to publish VOD update event');
  }
}

/**
 * Publish a VOD duration update event to Redis.
 * Subscribers will set the volatile cache entry with the new duration and is_live status.
 */
export async function publishVodDurationUpdate(
  tenantId: string,
  dbId: number,
  duration: number,
  isLive: boolean
): Promise<void> {
  const client = RedisService.getActiveClient();
  if (!client) return;

  const event: VodUpdateEvent = { type: 'VOD_DURATION_UPDATED', tenantId, dbId, duration, is_live: isLive };

  try {
    await client.publish(CACHE_CHANNEL, JSON.stringify(event));
  } catch (error) {
    const details = extractErrorDetails(error);
    getLogger().warn({ err: details, tenantId, dbId }, 'Failed to publish VOD duration update event');
  }
}

/**
 * Publish a game update event to Redis for cache invalidation.
 * Subscribers will invalidate all game-related cache keys for the tenant.
 */
export async function publishGameUpdate(tenantId: string): Promise<void> {
  const client = RedisService.getActiveClient();
  if (!client) return;

  const event: GameUpdateEvent = { type: 'GAME_UPDATED', tenantId };

  try {
    await client.publish(GAME_CACHE_CHANNEL, JSON.stringify(event));
  } catch (error) {
    const details = extractErrorDetails(error);
    getLogger().warn({ err: details, tenantId }, 'Failed to publish game update event');
  }
}

/** Optional identity hints for `invalidateAllVodCaches`. */
export interface VodCacheIdentity {
  /** Current platform (after the change). */
  platform?: string | undefined;
  /** Current platform VOD ID (after the change). */
  platformVodId?: string | undefined;
  /** Previous platform (before the change), when the `platform` column changed. */
  previousPlatform?: string | undefined;
  /** Previous platform VOD ID (before the change), when `platform_vod_id` changed. */
  previousPlatformVodId?: string | undefined;
}

/**
 * Invalidate every cached endpoint that references a VOD.
 *
 * Covers: the detail-by-id entry (swr/simple `vodStatic`, via
 * `invalidateVodStaticCache` which also clears tags, paginated list queries and
 * the chapter library), the detail-by-platform entry (swr/simple
 * `vodPlatform` — including the previous identity when the platform or
 * platform VOD ID changed; this key is NOT covered by the SCAN-based list
 * invalidation), the volatile (duration / is_live) entry, all game caches (the
 * VOD detail embeds games and the games list/library), and the tenant stats
 * key. Finally publishes a `VOD_UPDATED` event so worker processes and other
 * API instances refresh their in-process caches.
 */
export async function invalidateAllVodCaches(
  tenantId: string,
  dbId: number,
  identity: VodCacheIdentity = {}
): Promise<void> {
  await invalidateVodStaticCache(tenantId, dbId);
  await invalidateVodVolatileCache(tenantId, dbId);
  await invalidateGameTags(tenantId);

  const client = RedisService.getActiveClient();
  if (!client) {
    await publishVodUpdate(tenantId, dbId);
    return;
  }

  const platformKeys: string[] = [];
  if (identity.platform && identity.platformVodId) {
    platformKeys.push(swrKeys.vodPlatform(tenantId, identity.platform, identity.platformVodId));
    platformKeys.push(simpleKeys.vodPlatform(tenantId, identity.platform, identity.platformVodId));
  }
  if (identity.previousPlatform && identity.previousPlatformVodId) {
    platformKeys.push(swrKeys.vodPlatform(tenantId, identity.previousPlatform, identity.previousPlatformVodId));
    platformKeys.push(simpleKeys.vodPlatform(tenantId, identity.previousPlatform, identity.previousPlatformVodId));
  }

  if (platformKeys.length > 0) {
    try {
      await client.unlink(...platformKeys);
      for (const key of platformKeys) {
        defaultCacheContext.invalidateKey(key);
      }
    } catch (error) {
      getLogger().warn({ err: extractErrorDetails(error), tenantId, dbId }, 'Failed to unlink VOD platform cache keys');
    }
  }

  const statsKey = simpleKeys.stats(tenantId);
  await client.unlink(statsKey).catch(() => {});
  defaultCacheContext.invalidateKey(statsKey);

  await publishVodUpdate(tenantId, dbId);
}

/**
 * Register a Redis Pub/Sub subscriber for VOD cache invalidation events.
 * Handles VOD_UPDATED (invalidates static cache) and VOD_DURATION_UPDATED (sets volatile cache).
 * Subscribes to the cache channel and hooks into fastify's onClose for cleanup.
 */
export function registerCacheSubscriber(fastify: FastifyInstance): void {
  const { destroy } = createRedisSubscriber({
    channel: CACHE_CHANNEL,
    handler: handleCacheEvent,
    loggerModule: 'cache-subscriber',
  });

  fastify.addHook('onClose', destroy);
}

/**
 * Register a Redis Pub/Sub subscriber for game cache invalidation events.
 * Handles GAME_UPDATED (invalidates all game cache keys for the tenant).
 * Subscribes to the game cache channel and hooks into fastify's onClose for cleanup.
 */
export function registerGameCacheSubscriber(fastify: FastifyInstance): void {
  const { destroy } = createRedisSubscriber({
    channel: GAME_CACHE_CHANNEL,
    handler: handleGameCacheEvent,
    loggerModule: 'game-cache-subscriber',
  });

  fastify.addHook('onClose', destroy);
}
