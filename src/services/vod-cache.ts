import { isConnectionError } from '../db/utils/errors.js';
import { CacheKeys, simpleKeys, swrKeys } from '../utils/cache-keys.js';
import { isConnectionFailed, markConnectionFailed, markConnectionRestored } from '../utils/cache-state.js';
import { defaultCacheContext } from '../utils/cache.js';
import { extractErrorDetails } from '../utils/error.js';
import { getLogger } from '../utils/logger.js';
import { RedisService } from '../utils/redis-service.js';
import { invalidateVodTags, invalidateVodVolatileCache } from './cache-tags.js';

export { invalidateVodVolatileCache };

/** Volatile cache data for a VOD: dynamic fields that change during playback. */
export interface VodVolatileData {
  duration: number;
  is_live: boolean;
}

/** Retrieve volatile cache data (duration, is_live) for a VOD from Redis. */
export async function getVodVolatileCache(tenantId: string, dbId: number): Promise<VodVolatileData | null> {
  const client = RedisService.getActiveClient();
  if (!client) return null;

  try {
    const cached = await client.get(CacheKeys.vodVolatile(tenantId, dbId));
    if (cached == null || cached === '') return null;
    return JSON.parse(cached) as VodVolatileData;
  } catch (err) {
    const details = extractErrorDetails(err);
    getLogger().warn({ err: details, tenantId, dbId }, 'Failed to parse volatile cache entry');
    return null;
  }
}

/** Store volatile cache data (duration, is_live) for a VOD in Redis. */
export async function setVodVolatileCache(
  tenantId: string,
  dbId: number,
  data: VodVolatileData,
  ttl: number
): Promise<void> {
  const client = RedisService.getActiveClient();
  if (!client) return;

  try {
    await client.set(CacheKeys.vodVolatile(tenantId, dbId), JSON.stringify(data), 'EX', ttl);
  } catch (error) {
    const details = extractErrorDetails(error);
    getLogger().warn({ err: details, tenantId, dbId }, 'Volatile cache write failed');
  }
}

/**
 * Batch retrieve volatile cache data for multiple VODs using Redis MGET.
 * Returns a Map of dbId -> VodVolatileData, skipping corrupt entries.
 */
export async function getVodVolatileCacheBatch(
  tenantId: string,
  dbIds: number[]
): Promise<Map<number, VodVolatileData>> {
  const result = new Map<number, VodVolatileData>();

  if (dbIds.length === 0) return result;

  const client = RedisService.getActiveClient();
  if (!client) return result;

  const keys = dbIds.map((id) => CacheKeys.vodVolatile(tenantId, id));

  try {
    const values = await client.mget(...keys);
    dbIds.forEach((id, i) => {
      const raw = values[i];
      if (raw != null && raw !== '') {
        try {
          result.set(id, JSON.parse(raw) as VodVolatileData);
        } catch (err) {
          const details = extractErrorDetails(err);
          getLogger().debug({ err: details, id }, 'Skipping corrupt volatile cache entry');
        }
      }
    });
  } catch (err) {
    const details = extractErrorDetails(err);
    getLogger().warn({ err: details, tenantId }, 'Volatile cache batch read failed');
  }

  return result;
}

/**
 * Invalidate a VOD's static cache entry and all its tag-associated keys.
 * Tracks Redis connection state for resumable invalidation.
 */
export async function invalidateVodStaticCache(tenantId: string, dbId: number): Promise<void> {
  const client = RedisService.getActiveClient();
  if (!client) return;

  try {
    const swrKey = swrKeys.vodStatic(tenantId, dbId);
    await client.unlink(swrKey);
    defaultCacheContext.invalidateKey(swrKey);
    await invalidateVodTags(tenantId, dbId);

    if (isConnectionFailed(tenantId)) {
      markConnectionRestored(tenantId);
      getLogger().debug({ tenantId }, 'Redis connection restored, cache invalidation resumed');
    }

    getLogger().debug({ tenantId, dbId }, 'VOD static cache invalidated');
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
 * Invalidate the emote cache entry for a VOD.
 * Tracks Redis connection state for resumable invalidation.
 */
export async function invalidateEmoteCache(tenantId: string, vodId: number): Promise<void> {
  const client = RedisService.getActiveClient();
  if (!client) return;

  const cacheKey = CacheKeys.emotes(tenantId, vodId);
  const simpleCacheKey = simpleKeys.emotes(tenantId, vodId);

  try {
    await client.unlink(cacheKey, simpleCacheKey);

    if (isConnectionFailed(tenantId)) {
      markConnectionRestored(tenantId);
      getLogger().debug({ tenantId, vodId }, 'Redis connection restored, emote cache invalidation resumed');
    }

    getLogger().debug({ tenantId, vodId }, 'Emote cache invalidated');
  } catch (error) {
    if (!isConnectionFailed(tenantId) && isConnectionError(error)) {
      markConnectionFailed(tenantId);
      getLogger().warn(
        { tenantId, vodId, error: extractErrorDetails(error) },
        'Redis connection lost, emote cache invalidation suspended'
      );
    }
  }
}
