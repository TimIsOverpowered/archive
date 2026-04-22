import { RedisService } from '../utils/redis-service.js';
import { getDisableRedisCache } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import { extractErrorDetails } from '../utils/error.js';
import { invalidateVodTags, invalidateVodVolatileCache } from './cache-tags.js';
import { isConnectionFailed, markConnectionFailed, markConnectionRestored } from '../utils/cache-state.js';
import { isConnectionError } from '../db/client.js';

export { invalidateVodVolatileCache };

export interface VodVolatileData {
  duration: number;
  is_live: boolean;
}

function getStaticCacheKey(tenantId: string, dbId: number): string {
  return `vod:{${tenantId}}:${dbId}`;
}

function getVolatileCacheKey(tenantId: string, dbId: number): string {
  return `vod:volatile:{${tenantId}}:${dbId}`;
}

export async function getVodStaticCache(tenantId: string, dbId: number): Promise<string | null> {
  const client = RedisService.instance?.getClient() ?? null;
  if (!client || getDisableRedisCache()) return null;

  try {
    return await client.get(getStaticCacheKey(tenantId, dbId));
  } catch {
    return null;
  }
}

export async function setVodStaticCache(tenantId: string, dbId: number, data: string, ttl: number): Promise<void> {
  const client = RedisService.instance?.getClient() ?? null;
  if (!client || getDisableRedisCache()) return;

  try {
    await client.set(getStaticCacheKey(tenantId, dbId), data, 'EX', ttl);
  } catch (error) {
    const details = extractErrorDetails(error);
    getLogger().warn({ err: details, tenantId, dbId }, 'Static cache write failed');
  }
}

export async function getVodVolatileCache(tenantId: string, dbId: number): Promise<VodVolatileData | null> {
  const client = RedisService.instance?.getClient() ?? null;
  if (!client || getDisableRedisCache()) return null;

  try {
    const cached = await client.get(getVolatileCacheKey(tenantId, dbId));
    if (!cached) return null;
    return JSON.parse(cached) as VodVolatileData;
  } catch (err) {
    const details = extractErrorDetails(err);
    getLogger().warn({ err: details, tenantId, dbId }, 'Failed to parse volatile cache entry');
    return null;
  }
}

export async function setVodVolatileCache(
  tenantId: string,
  dbId: number,
  data: VodVolatileData,
  ttl: number
): Promise<void> {
  const client = RedisService.instance?.getClient() ?? null;
  if (!client || getDisableRedisCache()) return;

  try {
    await client.set(getVolatileCacheKey(tenantId, dbId), JSON.stringify(data), 'EX', ttl);
  } catch (error) {
    const details = extractErrorDetails(error);
    getLogger().warn({ err: details, tenantId, dbId }, 'Volatile cache write failed');
  }
}

export async function getVodVolatileCacheBatch(
  tenantId: string,
  dbIds: number[]
): Promise<Map<number, VodVolatileData>> {
  const result = new Map<number, VodVolatileData>();

  if (dbIds.length === 0) return result;

  const client = RedisService.instance?.getClient() ?? null;
  if (!client || getDisableRedisCache()) return result;

  const keys = dbIds.map((id) => getVolatileCacheKey(tenantId, id));

  try {
    const values = await client.mget(...keys);
    if (values) {
      dbIds.forEach((id, i) => {
        if (values[i]) {
          try {
            result.set(id, JSON.parse(values[i]) as VodVolatileData);
          } catch {
            // Corrupt entry, skip
          }
        }
      });
    }
  } catch (err) {
    const details = extractErrorDetails(err);
    getLogger().warn({ err: details, tenantId }, 'Volatile cache batch read failed');
  }

  return result;
}

export async function invalidateVodStaticCache(tenantId: string, dbId: number): Promise<void> {
  const client = RedisService.instance?.getClient() ?? null;
  if (getDisableRedisCache() || !client) return;

  try {
    await client.unlink(getStaticCacheKey(tenantId, dbId));
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

export async function invalidateEmoteCache(tenantId: string, vodId: number): Promise<void> {
  const client = RedisService.instance?.getClient() ?? null;
  if (getDisableRedisCache() || !client) return;

  const cacheKey = `emotes:{${tenantId}}:${vodId}`;

  try {
    await client.unlink(cacheKey);

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
