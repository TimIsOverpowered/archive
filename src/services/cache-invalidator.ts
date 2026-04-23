import type { FastifyInstance } from 'fastify';
import { RedisService } from '../utils/redis-service.js';
import { getLogger } from '../utils/logger.js';
import { extractErrorDetails } from '../utils/error.js';
import { invalidateVodVolatileCache } from './cache-tags.js';
import { setVodVolatileCache, invalidateVodStaticCache } from './vod-cache.js';
import { VOD_VOLATILE_CACHE_TTL } from '../constants.js';

const CACHE_CHANNEL = 'cache:vod';

interface VodUpdateEvent {
  type: 'VOD_UPDATED' | 'VOD_DURATION_UPDATED';
  tenantId: string;
  dbId: number;
  duration?: number;
  is_live?: boolean;
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
 * Register a Redis Pub/Sub subscriber for VOD cache invalidation events.
 * Handles VOD_UPDATED (invalidates static cache) and VOD_DURATION_UPDATED (sets volatile cache).
 * Subscribes to the cache channel and hooks into fastify's onClose for cleanup.
 */
export function registerCacheSubscriber(fastify: FastifyInstance): void {
  const mainClient = RedisService.getActiveClient();
  if (!mainClient) return;

  const subClient = mainClient.duplicate();
  const log = getLogger().child({ module: 'cache-subscriber' });

  subClient.on('error', (err) => {
    log.warn({ err: extractErrorDetails(err) }, 'Cache subscriber client error');
  });

  subClient.on('subscribe', (channel) => {
    log.debug({ channel }, 'Cache subscriber connected');
  });

  subClient.on('unsubscribe', (channel) => {
    log.debug({ channel }, 'Cache subscriber disconnected');
  });

  subClient.on('reconnect', () => {
    log.warn('Cache subscriber redis reconnecting, re-subscribing');
    void subClient.subscribe(CACHE_CHANNEL);
  });

  subClient.on('message', (_channel: string, message: string) => {
    if (_channel !== CACHE_CHANNEL) return;

    let event: VodUpdateEvent;
    try {
      event = JSON.parse(message) as VodUpdateEvent;
    } catch {
      log.warn({ message }, 'Failed to parse cache event');
      return;
    }

    (async () => {
      try {
        if (event.type === 'VOD_DURATION_UPDATED' && event.duration !== undefined) {
          await setVodVolatileCache(
            event.tenantId,
            event.dbId,
            { duration: event.duration, is_live: event.is_live ?? false },
            VOD_VOLATILE_CACHE_TTL
          );
        } else {
          await invalidateVodStaticCache(event.tenantId, event.dbId);
          await invalidateVodVolatileCache(event.tenantId, event.dbId);
        }
      } catch (error) {
        const details = extractErrorDetails(error);
        log.warn({ err: details, event }, 'Failed to process cache event');
      }
    })();
  });

  void subClient.subscribe(CACHE_CHANNEL);

  fastify.addHook('onClose', async () => {
    try {
      await subClient.unsubscribe(CACHE_CHANNEL);
    } finally {
      await subClient.quit();
    }
    log.debug('Cache subscriber disconnected');
  });
}
