import { redisClient } from '../api/plugins/redis.plugin.js';
import { logger } from '../utils/logger.js';

export async function withCache<T>(key: string, ttl: number, fetcher: () => Promise<T>): Promise<T> {
  if (process.env.DISABLE_REDIS_CACHE === 'true' || !redisClient) return fetcher();

  try {
    const cached = await redisClient.get(key);
    if (cached) return JSON.parse(cached) as T;
  } catch (err) {
    logger.warn({ err, key }, 'Cache read failed, falling back to DB');
  }

  const result = await fetcher();

  try {
    await redisClient.set(key, JSON.stringify(result), 'EX', ttl);
  } catch (err) {
    logger.warn({ err, key }, 'Cache write failed');
  }

  return result;
}
