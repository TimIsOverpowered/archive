import { RedisService } from '../utils/redis-service.js';
import { getDisableRedisCache } from '../config/env-accessors.js';
import { logger } from '../utils/logger.js';

export async function withCache<T>(key: string, ttl: number, fetcher: () => Promise<T>): Promise<T> {
  if (getDisableRedisCache() || !RedisService.getClient()) return fetcher();

  try {
    const cached = await RedisService.getClient().get(key);
    if (cached) return JSON.parse(cached) as T;
  } catch (err) {
    logger.warn({ err, key }, 'Cache read failed, falling back to DB');
  }

  const result = await fetcher();

  try {
    await RedisService.getClient().set(key, JSON.stringify(result), 'EX', ttl);
  } catch (err) {
    logger.warn({ err, key }, 'Cache write failed');
  }

  return result;
}
