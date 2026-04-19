import { redisClient } from '../api/plugins/redis.plugin.js';
import { getDisableRedisCache } from '../config/env-accessors.js';
import { logger } from '../utils/logger.js';

let redisConnectionFailed = false;

export async function invalidateTenantVodListCache(tenantId: string): Promise<void> {
  if (getDisableRedisCache() || !redisClient) {
    return;
  }

  try {
    const keysToDelete: string[] = [];

    const stream = redisClient.scanStream({ match: `vods:${tenantId}:*`, count: 100 });
    for await (const keys of stream) {
      keysToDelete.push(...keys);
    }

    if (keysToDelete.length > 0) {
      await redisClient.unlink(...keysToDelete);
    }

    if (redisConnectionFailed) {
      redisConnectionFailed = false;
      logger.debug({ tenantId }, 'Redis connection restored, tenant list cache invalidation resumed');
    }

    logger.debug({ tenantId }, 'Tenant VOD list cache invalidated');
  } catch (error) {
    const errorMessage = String(error);

    if (!redisConnectionFailed && errorMessage.includes('ECONNREFUSED')) {
      redisConnectionFailed = true;
      logger.warn({ tenantId, error: errorMessage }, 'Redis connection lost, tenant list cache invalidation suspended');
    }
  }
}

export async function invalidateEmoteCache(tenantId: string, vodId: number): Promise<void> {
  if (getDisableRedisCache() || !redisClient) {
    return;
  }

  const cacheKey = `emotes:${tenantId}:${vodId}`;

  try {
    await redisClient.unlink(cacheKey);

    if (redisConnectionFailed) {
      redisConnectionFailed = false;
      logger.debug({ tenantId, vodId }, 'Redis connection restored, emote cache invalidation resumed');
    }

    logger.debug({ tenantId, vodId }, 'Emote cache invalidated');
  } catch (error) {
    const errorMessage = String(error);

    if (!redisConnectionFailed && errorMessage.includes('ECONNREFUSED')) {
      redisConnectionFailed = true;
      logger.warn(
        { tenantId, vodId, error: errorMessage },
        'Redis connection lost, emote cache invalidation suspended'
      );
    }
  }
}

export async function invalidateVodCache(tenantId: string, vodId: number): Promise<void> {
  if (getDisableRedisCache() || !redisClient) {
    return;
  }

  const vodIdStr = String(vodId);

  try {
    await redisClient.unlink(`vod:${tenantId}:${vodIdStr}`);

    const keysToDelete: string[] = [`vod:${tenantId}:${vodIdStr}`];

    const stream = redisClient.scanStream({ match: `vods:${tenantId}:*`, count: 100 });
    for await (const keys of stream) {
      keysToDelete.push(...keys);
    }

    if (keysToDelete.length > 0) {
      await redisClient.unlink(...keysToDelete); // single round trip
    }

    if (redisConnectionFailed) {
      redisConnectionFailed = false;
      logger.debug({ tenantId, vodId }, 'Redis connection restored, cache invalidation resumed');
    }

    logger.debug({ tenantId, vodId }, 'VOD cache invalidated');
  } catch (error) {
    const errorMessage = String(error);

    if (!redisConnectionFailed && errorMessage.includes('ECONNREFUSED')) {
      redisConnectionFailed = true;
      logger.warn({ tenantId, vodId, error: errorMessage }, 'Redis connection lost, cache invalidation suspended');
    }
  }
}
