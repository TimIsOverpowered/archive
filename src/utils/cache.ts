import { RedisService } from '../utils/redis-service.js';
import { getDisableRedisCache } from '../config/env-accessors.js';
import { extractErrorDetails } from './error.js';
import { getLogger } from '../utils/logger.js';

export async function withCache<T>(key: string, ttl: number, fetcher: () => Promise<T>): Promise<T> {
  const client = getDisableRedisCache() ? null : RedisService.getClient();
  if (!client) return fetcher();

  try {
    const cached = await client.get(key);
    if (cached) return JSON.parse(cached) as T;
  } catch (err) {
    const details = extractErrorDetails(err);
    getLogger().warn({ err: details, key }, 'Cache read failed, falling back to DB');
  }

  const result = await fetcher();

  try {
    await client.set(key, JSON.stringify(result), 'EX', ttl);
  } catch (err) {
    const details = extractErrorDetails(err);
    getLogger().warn({ err: details, key }, 'Cache write failed');
  }

  return result;
}
