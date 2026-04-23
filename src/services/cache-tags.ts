import { RedisService } from '../utils/redis-service.js';
import { getLogger } from '../utils/logger.js';
import { extractErrorDetails } from '../utils/error.js';
import { isConnectionFailed, markConnectionFailed, markConnectionRestored } from '../utils/cache-state.js';
import { MAX_CACHE_PAGES } from '../constants.js';
import { isConnectionError } from '../db/utils/errors.js';
import { CacheKeys } from '../utils/cache-keys.js';

function extractPageFromKey(key: string): number | null {
  const parts = key.split(':');
  const pageIdx = parts.indexOf('page');
  if (pageIdx === -1 || pageIdx + 1 >= parts.length) return null;
  const pageStr = parts[pageIdx + 1];
  if (!pageStr) return null;
  const page = parseInt(pageStr, 10);
  return isNaN(page) ? null : page;
}

/**
 * Cache a VOD list query result and register tag-based associations for all VODs in the list.
 * Enables batch invalidation by VOD ID later.
 */
export async function registerVodTags(
  tenantId: string,
  vods: { id: number }[],
  cacheKey: string,
  data: string,
  ttl: number
): Promise<void> {
  const client = RedisService.getActiveClient();
  if (!client) return;

  if (isConnectionFailed(tenantId)) {
    return;
  }

  const page = extractPageFromKey(cacheKey);
  if (page !== null && page > MAX_CACHE_PAGES) {
    return;
  }

  const tagTtlMs = ttl * 1000 + 60_000;

  try {
    const CHUNK_SIZE = 50;

    for (let i = 0; i < vods.length; i += CHUNK_SIZE) {
      const chunk = client.pipeline();
      if (i === 0) {
        chunk.set(cacheKey, data, 'EX', ttl);
      }

      for (const vod of vods.slice(i, i + CHUNK_SIZE)) {
        const tagKey = CacheKeys.vodTags(tenantId, vod.id);
        chunk.sadd(tagKey, cacheKey);
        chunk.pexpire(tagKey, tagTtlMs);
      }

      const results = await chunk.exec();
      if (results?.some(([err]) => err)) {
        const firstErr = results.find(([err]) => err)?.[1] ?? null;
        throw firstErr ?? new Error('Pipeline command failed');
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
      const result = await client.sscan(tagKey, cursor, 'COUNT', 50);
      cursor = result[0];
      const taggedKeys = result[1];

      if (taggedKeys.length > 0) {
        await client.unlink(...taggedKeys);
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
 * Invalidate the volatile cache entry for a VOD (duration, is_live).
 * Tracks Redis connection state to suspend/resume invalidation on failures.
 */
export async function invalidateVodVolatileCache(tenantId: string, dbId: number): Promise<void> {
  const client = RedisService.getActiveClient();
  if (!client) return;

  try {
    await client.unlink(CacheKeys.vodVolatile(tenantId, dbId));

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
