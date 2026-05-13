import { Cache, CacheTag, RedisBatch } from '../constants.js';
import { isConnectionError } from '../db/utils/errors.js';
import { CacheKeys, swrKeys } from '../utils/cache-keys.js';
import { isConnectionFailed, markConnectionFailed, markConnectionRestored } from '../utils/cache-state.js';
import { defaultCacheContext } from '../utils/cache.js';
import { extractErrorDetails } from '../utils/error.js';
import { getLogger } from '../utils/logger.js';
import { RedisService } from '../utils/redis-service.js';

export async function registerVodTags(
  tenantId: string,
  vods: { id: number }[],
  cacheKey: string,
  ttl: number,
  page: number
): Promise<void> {
  const client = RedisService.getActiveClient();
  if (!client) return;

  if (isConnectionFailed(tenantId)) {
    return;
  }

  if (page > Cache.MAX_PAGES) {
    return;
  }

  const tagTtlMs = ttl * 1000 + CacheTag.TTL_BUFFER_MS;

  try {
    for (let i = 0; i < vods.length; i += RedisBatch.CHUNK_SIZE) {
      const chunk = client.pipeline();

      for (const vod of vods.slice(i, i + RedisBatch.CHUNK_SIZE)) {
        const tagKey = CacheKeys.vodTags(tenantId, vod.id);
        chunk.sadd(tagKey, cacheKey);
        chunk.pexpire(tagKey, tagTtlMs);
      }

      const results = await chunk.exec();
      if (results != null && results.some(([err]) => err !== null && err !== undefined)) {
        getLogger().warn({ tenantId, cacheKey, page }, 'Redis pipeline failed, skipping tag registration');
      }
    }

    if (isConnectionFailed(tenantId)) {
      markConnectionRestored(tenantId);
      getLogger().debug({ tenantId }, 'Redis connection restored, tag registration resumed');
    }
  } catch (error) {
    if (!isConnectionFailed(tenantId) && isConnectionError(error)) {
      markConnectionFailed(tenantId);
      getLogger().warn(
        { tenantId, cacheKey, error: extractErrorDetails(error) },
        'Redis connection lost, tag registration suspended'
      );
    }
  }
}

/**
 * Invalidate all cache keys tagged with a specific VOD ID.
 * Uses Redis SSCAN to iterate over tagged keys and unlink them.
 */
export async function invalidateVodTags(tenantId: string, dbId: number): Promise<void> {
  const client = RedisService.getActiveClient();
  if (!client) return;

  try {
    const tagKey = CacheKeys.vodTags(tenantId, dbId);
    let cursor = '0';

    do {
      const result = await client.sscan(tagKey, cursor, 'COUNT', RedisBatch.SCAN_COUNT);
      cursor = result[0];
      const taggedKeys = result[1];

      if (taggedKeys.length > 0) {
        await client.unlink(...taggedKeys);
        for (const k of taggedKeys) {
          defaultCacheContext.invalidateKey(k);
        }
      }
    } while (cursor !== '0');

    await client.del(tagKey);

    if (isConnectionFailed(tenantId)) {
      markConnectionRestored(tenantId);
      getLogger().debug({ tenantId }, 'Redis connection restored, tag invalidation resumed');
    }
  } catch (error) {
    if (!isConnectionFailed(tenantId) && isConnectionError(error)) {
      markConnectionFailed(tenantId);
      getLogger().warn(
        { tenantId, dbId, error: extractErrorDetails(error) },
        'Redis connection lost, tag invalidation suspended'
      );
    }
  }
}

/**
 * Invalidate all VOD list queries for a tenant using Redis SCAN.
 * This guarantees lists update immediately when new VODs are added.
 */
export async function invalidateVodQueries(tenantId: string): Promise<void> {
  const client = RedisService.getActiveClient();
  if (!client) return;

  try {
    let cursor = '0';
    do {
      const result = await client.scan(cursor, 'MATCH', `*vods:{${tenantId}}*`, 'COUNT', RedisBatch.SCAN_COUNT);
      cursor = result[0];
      const keys = result[1];

      if (keys.length > 0) {
        await client.unlink(...keys);
        for (const k of keys) {
          defaultCacheContext.invalidateKey(k);
        }
      }
    } while (cursor !== '0');
  } catch (error) {
    if (!isConnectionFailed(tenantId) && isConnectionError(error)) {
      markConnectionFailed(tenantId);
    }
  }
}

/**
 * Invalidate the volatile cache entry for a VOD (duration, is_live).
 * Tracks Redis connection state to suspend/resume invalidation on failures.
 */
export async function invalidateVodVolatileCache(tenantId: string, dbId: number): Promise<void> {
  const client = RedisService.getActiveClient();
  if (!client) return;

  try {
    const keys = [
      CacheKeys.vodVolatile(tenantId, dbId),
      swrKeys.vodVolatile(tenantId, dbId),
      CacheKeys.vodMeta(tenantId, dbId),
    ];

    await client.unlink(...keys);
    for (const k of keys) {
      defaultCacheContext.invalidateKey(k);
    }

    if (isConnectionFailed(tenantId)) {
      markConnectionRestored(tenantId);
      getLogger().debug({ tenantId }, 'Redis connection restored, cache invalidation resumed');
    }

    getLogger().debug({ tenantId, dbId }, 'VOD volatile cache invalidated');
  } catch (error) {
    if (!isConnectionFailed(tenantId) && isConnectionError(error)) {
      markConnectionFailed(tenantId);
      getLogger().warn(
        { tenantId, dbId, error: extractErrorDetails(error) },
        'Redis connection lost, cache invalidation suspended'
      );
    }
  }
}

/**
 * Invalidate all game-related cache keys for a tenant.
 * Uses Redis SCAN with pattern matching to find and unlink all games* keys.
 */
export async function invalidateGameTags(tenantId: string): Promise<void> {
  const client = RedisService.getActiveClient();
  if (!client) return;

  try {
    let cursor = '0';

    do {
      const result = await client.scan(cursor, 'MATCH', 'games*', 'COUNT', RedisBatch.SCAN_COUNT);
      cursor = result[0];
      const keys = result[1];

      if (keys.length > 0) {
        await client.unlink(...keys);
      }
    } while (cursor !== '0');

    if (isConnectionFailed(tenantId)) {
      markConnectionRestored(tenantId);
      getLogger().debug({ tenantId }, 'Redis connection restored, game cache invalidation resumed');
    }

    getLogger().debug({ tenantId }, 'Game cache invalidated');
  } catch (error) {
    if (!isConnectionFailed(tenantId) && isConnectionError(error)) {
      markConnectionFailed(tenantId);
      getLogger().warn(
        { tenantId, error: extractErrorDetails(error) },
        'Redis connection lost, game cache invalidation suspended'
      );
    }
  }
}
