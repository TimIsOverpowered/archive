import type { FastifyInstance } from 'fastify';
import { Cache } from '../constants.js';
import { simpleKeys } from '../utils/cache-keys.js';
import { defaultCacheContext } from '../utils/cache.js';
import { extractErrorDetails } from '../utils/error.js';
import { getLogger } from '../utils/logger.js';
import { RedisService } from '../utils/redis-service.js';
import { createRedisSubscriber } from '../utils/redis-subscriber.js';
import { invalidateGameTags, invalidateVodVolatileCache } from './cache-tags.js';
import { setVodVolatileCache, invalidateVodStaticCache } from './vod-cache.js';

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
