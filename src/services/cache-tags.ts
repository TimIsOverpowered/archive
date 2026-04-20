import { RedisService } from '../utils/redis-service.js';
import { getDisableRedisCache } from '../config/env-accessors.js';
import { getLogger } from '../utils/logger.js';
import { extractErrorDetails } from '../utils/error.js';
import { redisConnectionFailed, markConnectionFailed, markConnectionRestored } from '../utils/cache-state.js';
import { MAX_CACHE_PAGES } from '../constants.js';

function extractPageFromKey(key: string): number | null {
  const parts = key.split(':');
  const pageIdx = parts.indexOf('page');
  if (pageIdx === -1 || pageIdx + 1 >= parts.length) return null;
  const page = parseInt(parts[pageIdx + 1], 10);
  return isNaN(page) ? null : page;
}

export async function registerVodTags(
  tenantId: string,
  vods: { id: number }[],
  cacheKey: string,
  data: string,
  ttl: number
): Promise<void> {
  const client = RedisService.getClient();
  if (!client || getDisableRedisCache()) return;

  if (redisConnectionFailed.get(tenantId)) {
    return;
  }

  const page = extractPageFromKey(cacheKey);
  if (page !== null && page > MAX_CACHE_PAGES) {
    return;
  }

  const tagTtlMs = ttl * 1000 + 60_000;

  try {
    await client.set(cacheKey, data, 'EX', ttl);

    for (const vod of vods) {
      const tagKey = `vods:tags:{${tenantId}}:${vod.id}`;
      await client.sadd(tagKey, cacheKey);
      await client.pexpire(tagKey, tagTtlMs);
    }
  } catch (error) {
    const { message } = extractErrorDetails(error);
    if (message.includes('ECONNREFUSED')) {
      markConnectionFailed(tenantId);
    }
    getLogger().warn({ tenantId, cacheKey, error: extractErrorDetails(error) }, 'Tag registration failed');
  }
}

export async function invalidateVodTags(tenantId: string, dbId: number): Promise<void> {
  const client = RedisService.getClient();
  if (getDisableRedisCache() || !client) return;

  try {
    const tagKey = `vods:tags:{${tenantId}}:${dbId}`;
    let cursor = '0';

    do {
      const result = await client.sscan(tagKey, cursor, 'COUNT', 50);
      cursor = result[0];
      const taggedKeys = result[1];

      if (taggedKeys.length > 0) {
        await client.unlink(...taggedKeys);
      }
    } while (cursor !== '0');

    await client.del(tagKey);
  } catch (error) {
    const { message } = extractErrorDetails(error);
    if (message.includes('ECONNREFUSED')) {
      markConnectionFailed(tenantId);
    }
  }
}

export async function invalidateVodVolatileCache(tenantId: string, dbId: number): Promise<void> {
  const client = RedisService.getClient();
  if (getDisableRedisCache() || !client) return;

  try {
    await client.unlink(`vod:volatile:{${tenantId}}:${dbId}`);

    if (redisConnectionFailed.get(tenantId)) {
      markConnectionRestored(tenantId);
      getLogger().debug({ tenantId }, 'Redis connection restored, cache invalidation resumed');
    }

    getLogger().debug({ tenantId, dbId }, 'VOD volatile cache invalidated');
  } catch (error) {
    const { message } = extractErrorDetails(error);

    if (!redisConnectionFailed.get(tenantId) && message.includes('ECONNREFUSED')) {
      markConnectionFailed(tenantId);
      getLogger().warn({ tenantId, dbId, error: message }, 'Redis connection lost, cache invalidation suspended');
    }
  }
}
