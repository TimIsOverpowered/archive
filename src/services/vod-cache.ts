import { redisClient } from '../api/plugins/redis.plugin.js';
import { logger } from '../utils/logger.js';

let redisConnectionFailed = false;

export async function invalidateVodCache(tenantId: string, vodId: number): Promise<void> {
  if (process.env.DISABLE_REDIS_CACHE === 'true' || !redisClient) {
    return;
  }

  const vodIdStr = String(vodId);

  try {
    await redisClient.unlink(`vod:${tenantId}:${vodIdStr}`);

    const stream = redisClient.scanStream({
      match: `vods:${tenantId}:*`,
      count: 100,
    });

    for await (const keys of stream) {
      for (const key of keys) {
        await redisClient.unlink(key);
      }
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
