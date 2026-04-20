import { RedisService } from '../utils/redis-service.js';
import { getDisableRedisCache } from '../config/env-accessors.js';
import { extractErrorDetails } from './error.js';
import { getLogger } from '../utils/logger.js';

const SWR_FAILURES = new Map<string, number>();
const MAX_SWR_FAILURES = 3;

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

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

const inflightPromises = new Map<string, Promise<unknown>>();

export async function withStaleWhileRevalidate<T>(
  key: string,
  ttl: number,
  staleAfter: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const client = getDisableRedisCache() ? null : RedisService.getClient();
  if (!client) return fetcher();

  const now = Date.now();

  try {
    const cached = await client.get(key);
    if (cached) {
      const entry: CacheEntry<T> = JSON.parse(cached);
      const isStale = now - entry.timestamp > staleAfter * 1000;

      if (isStale) {
        if (!inflightPromises.has(key)) {
          const revalidatePromise = revalidateWithRetry(client, key, ttl, fetcher).catch(() =>
            inflightPromises.delete(key)
          );

          inflightPromises.set(key, revalidatePromise);
        }

        return entry.data;
      }

      return entry.data;
    }
  } catch (err) {
    const details = extractErrorDetails(err);
    getLogger().warn({ err: details, key }, 'SWR cache read failed, falling back to DB');
  }

  if (inflightPromises.has(key)) {
    return (await inflightPromises.get(key)) as T;
  }

  const fetchPromise = revalidateWithRetry(client, key, ttl, fetcher).catch((err) => {
    inflightPromises.delete(key);
    throw err;
  });

  inflightPromises.set(key, fetchPromise);
  return await fetchPromise;
}

async function revalidateWithRetry<T>(
  client: ReturnType<typeof RedisService.getClient>,
  key: string,
  ttl: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const log = getLogger().child({ key });
  const failures = SWR_FAILURES.get(key) ?? 0;

  if (failures >= MAX_SWR_FAILURES) {
    SWR_FAILURES.delete(key);
    inflightPromises.delete(key);
    log.warn('SWR revalidation failing repeatedly, skipping retry');
    throw new Error('SWR revalidation limit exceeded');
  }

  try {
    const data = await fetcher();
    SWR_FAILURES.delete(key);
    await client.set(key, JSON.stringify({ data, timestamp: Date.now() }), 'EX', ttl);
    inflightPromises.delete(key);
    return data;
  } catch (err) {
    SWR_FAILURES.set(key, failures + 1);
    log.warn({ err: extractErrorDetails(err), attempt: failures + 1 }, 'SWR revalidation failed');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const data = await fetcher();
      SWR_FAILURES.delete(key);
      await client.set(key, JSON.stringify({ data, timestamp: Date.now() }), 'EX', ttl);
      inflightPromises.delete(key);
      return data;
    } catch (retryErr) {
      SWR_FAILURES.delete(key);
      inflightPromises.delete(key);
      log.error({ err: extractErrorDetails(retryErr) }, 'SWR revalidation exhausted retries');
      throw retryErr;
    }
  }
}
