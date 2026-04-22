import { RedisService } from '../utils/redis-service.js';
import { getDisableRedisCache } from '../config/env.js';
import { extractErrorDetails } from './error.js';
import { getLogger } from '../utils/logger.js';
import { LRUCache } from 'lru-cache';
import { retryWithBackoff } from './retry.js';

// NOTE: SWR_FAILURES is in-memory only. In multi-instance deployments (multiple
// worker/api processes), failure counts are per-instance, not global. This means
// a fetcher that fails on instance A won't trigger the MAX_SWR_FAILURES limit on
// instance B, potentially causing redundant failures across instances.
//
// If multi-instance deployment is planned, migrate failure tracking to Redis:
//   - Use a Redis key like `swr:failures:{key}` with INCR/EXPIRE pattern
//   - Check the count before each revalidation attempt
//   - This ensures all instances share the same failure threshold
const SWR_FAILURES = new LRUCache<string, number>({
  max: 5000,
  ttl: 5 * 60 * 1000,
  allowStale: false,
});
const MAX_SWR_FAILURES = 3;

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const inflightSimple = new LRUCache<string, Promise<unknown>>({
  max: 5000,
  ttl: 30_000,
  allowStale: false,
});

export async function withCache<T>(key: string, ttl: number, fetcher: () => Promise<T>): Promise<T> {
  const client = getDisableRedisCache() ? null : (RedisService.instance?.getClient() ?? null);
  if (!client) return fetcher();

  try {
    const cached = await client.get(key);
    if (cached) return JSON.parse(cached) as T;
  } catch (err) {
    const details = extractErrorDetails(err);
    getLogger().warn({ err: details, key }, 'Cache read failed, falling back to DB');
  }

  const inflight = inflightSimple.get(key) as Promise<T> | undefined;
  if (inflight) return inflight;

  const promise = fetcher()
    .then(async (result) => {
      inflightSimple.delete(key);
      try {
        await client.set(key, JSON.stringify(result), 'EX', ttl);
      } catch (err) {
        const details = extractErrorDetails(err);
        getLogger().warn({ err: details, key }, 'Cache write failed');
      }
      return result;
    })
    .catch((err) => {
      inflightSimple.delete(key);
      throw err;
    });

  inflightSimple.set(key, promise as Promise<unknown>);
  return promise;
}

const inflightPromises = new LRUCache<string, Promise<unknown>>({
  max: 5000,
  ttl: 60 * 1000,
  allowStale: false,
});

const INFIGHT_TIMEOUT_MS = 30_000;

export async function withStaleWhileRevalidate<T>(
  key: string,
  ttl: number,
  staleAfter: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const client = getDisableRedisCache() ? null : (RedisService.instance?.getClient() ?? null);
  if (!client) return fetcher();

  const now = Date.now();

  try {
    const cached = await client.get(key);
    if (cached) {
      const entry: CacheEntry<T> = JSON.parse(cached);
      const isStale = now - entry.timestamp > staleAfter * 1000;

      if (!isStale) return entry.data;

      // Stale — serve immediately, revalidate in background
      if (!inflightPromises.get(key)) {
        const revalidatePromise = withTimeout(
          revalidateWithRetry(client, key, ttl, fetcher).catch(() => inflightPromises.delete(key)),
          INFIGHT_TIMEOUT_MS
        );

        inflightPromises.set(key, revalidatePromise);
      }

      return entry.data;
    }
  } catch (err) {
    const details = extractErrorDetails(err);
    getLogger().warn({ err: details, key }, 'SWR cache read failed, falling back to DB');
  }

  if (inflightPromises.get(key)) {
    return (await inflightPromises.get(key)) as T;
  }

  const fetchPromise = withTimeout(
    revalidateWithRetry(client, key, ttl, fetcher).catch((err) => {
      inflightPromises.delete(key);
      throw err;
    }),
    INFIGHT_TIMEOUT_MS
  );

  inflightPromises.set(key, fetchPromise);
  return await fetchPromise;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`In-flight fetch timed out after ${ms}ms`));
      }, ms);
    }),
  ]);
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
    const data = await retryWithBackoff(fetcher, { attempts: 2, baseDelayMs: 2000 });
    SWR_FAILURES.delete(key);
    await client.set(key, JSON.stringify({ data, timestamp: Date.now() }), 'EX', ttl);
    inflightPromises.delete(key);
    return data;
  } catch (err) {
    SWR_FAILURES.set(key, failures + 1);
    inflightPromises.delete(key);
    log.error({ err: extractErrorDetails(err) }, 'SWR revalidation exhausted retries');
    throw err;
  }
}
