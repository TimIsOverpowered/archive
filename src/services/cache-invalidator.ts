import type { FastifyInstance } from 'fastify';
import { RedisService } from '../utils/redis-service.js';
import { getDisableRedisCache } from '../config/env.js';
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

export async function publishVodUpdate(tenantId: string, dbId: number): Promise<void> {
  const client = RedisService.instance?.getClient() ?? null;
  if (!client || getDisableRedisCache()) return;

  const event: VodUpdateEvent = { type: 'VOD_UPDATED', tenantId, dbId };

  try {
    await client.publish(CACHE_CHANNEL, JSON.stringify(event));
  } catch (error) {
    const details = extractErrorDetails(error);
    getLogger().warn({ err: details, tenantId, dbId }, 'Failed to publish VOD update event');
  }
}

export async function publishVodDurationUpdate(
  tenantId: string,
  dbId: number,
  duration: number,
  isLive: boolean
): Promise<void> {
  const client = RedisService.instance?.getClient() ?? null;
  if (!client || getDisableRedisCache()) return;

  const event: VodUpdateEvent = { type: 'VOD_DURATION_UPDATED', tenantId, dbId, duration, is_live: isLive };

  try {
    await client.publish(CACHE_CHANNEL, JSON.stringify(event));
  } catch (error) {
    const details = extractErrorDetails(error);
    getLogger().warn({ err: details, tenantId, dbId }, 'Failed to publish VOD duration update event');
  }
}

export function registerCacheSubscriber(fastify: FastifyInstance): void {
  const mainClient = RedisService.instance?.getClient() ?? null;
  if (!mainClient || getDisableRedisCache()) return;

  const subClient = mainClient.duplicate();
  const log = getLogger().child({ module: 'cache-subscriber' });

  subClient.on('error', (err) => {
    log.warn({ err: extractErrorDetails(err) }, 'Cache subscriber client error');
  });

  subClient.on('subscribe', (channel) => {
    log.debug({ channel }, 'Cache subscriber connected');
  });

  subClient.on('message', async (channel, message) => {
    if (channel !== CACHE_CHANNEL) return;

    let event: VodUpdateEvent;
    try {
      event = JSON.parse(message) as VodUpdateEvent;
    } catch {
      log.warn({ message }, 'Failed to parse cache event');
      return;
    }

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
