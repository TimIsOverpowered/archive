import { RedisService } from '../utils/redis-service.js';
import { getDisableRedisCache } from '../config/env-accessors.js';
import { getLogger } from '../utils/logger.js';
import { extractErrorDetails } from '../utils/error.js';

const redisConnectionFailed = new Map<string, boolean>();

export async function invalidateTenantVodListCache(tenantId: string): Promise<void> {
  const client = RedisService.getClient();
  if (getDisableRedisCache() || !client) {
    return;
  }

  try {
    const keysToDelete: string[] = [];

    const stream = client.scanStream({ match: `vods:${tenantId}:*`, count: 100 });
    for await (const keys of stream) {
      keysToDelete.push(...keys);
    }

    if (keysToDelete.length > 0) {
      await client.unlink(...keysToDelete);
    }

    if (redisConnectionFailed.get(tenantId)) {
      redisConnectionFailed.set(tenantId, false);
      getLogger().debug({ tenantId }, 'Redis connection restored, tenant list cache invalidation resumed');
    }

    getLogger().debug({ tenantId }, 'Tenant VOD list cache invalidated');
  } catch (error) {
    const { message } = extractErrorDetails(error);

    if (!redisConnectionFailed.get(tenantId) && message.includes('ECONNREFUSED')) {
      redisConnectionFailed.set(tenantId, true);
      getLogger().warn({ tenantId, error: message }, 'Redis connection lost, tenant list cache invalidation suspended');
    }
  }
}

export async function invalidateEmoteCache(tenantId: string, vodId: number): Promise<void> {
  const client = RedisService.getClient();
  if (getDisableRedisCache() || !client) {
    return;
  }

  const cacheKey = `emotes:${tenantId}:${vodId}`;

  try {
    await client.unlink(cacheKey);

    if (redisConnectionFailed.get(tenantId)) {
      redisConnectionFailed.set(tenantId, false);
      getLogger().debug({ tenantId, vodId }, 'Redis connection restored, emote cache invalidation resumed');
    }

    getLogger().debug({ tenantId, vodId }, 'Emote cache invalidated');
  } catch (error) {
    const { message } = extractErrorDetails(error);

    if (!redisConnectionFailed.get(tenantId) && message.includes('ECONNREFUSED')) {
      redisConnectionFailed.set(tenantId, true);
      getLogger().warn(
        { tenantId, vodId, error: message },
        'Redis connection lost, emote cache invalidation suspended'
      );
    }
  }
}

export async function invalidateVodCache(tenantId: string, vodId: number): Promise<void> {
  const client = RedisService.getClient();
  if (getDisableRedisCache() || !client) {
    return;
  }

  const vodIdStr = String(vodId);

  try {
    await client.unlink(`vod:${tenantId}:${vodIdStr}`);

    const keysToDelete: string[] = [`vod:${tenantId}:${vodIdStr}`];

    const stream = client.scanStream({ match: `vods:${tenantId}:*`, count: 100 });
    for await (const keys of stream) {
      keysToDelete.push(...keys);
    }

    if (keysToDelete.length > 0) {
      await client.unlink(...keysToDelete); // single round trip
    }

    if (redisConnectionFailed.get(tenantId)) {
      redisConnectionFailed.set(tenantId, false);
      getLogger().debug({ tenantId, vodId }, 'Redis connection restored, cache invalidation resumed');
    }

    getLogger().debug({ tenantId, vodId }, 'VOD cache invalidated');
  } catch (error) {
    const { message } = extractErrorDetails(error);

    if (!redisConnectionFailed.get(tenantId) && message.includes('ECONNREFUSED')) {
      redisConnectionFailed.set(tenantId, true);
      getLogger().warn({ tenantId, vodId, error: message }, 'Redis connection lost, cache invalidation suspended');
    }
  }
}
