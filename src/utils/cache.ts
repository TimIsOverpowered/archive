import { RedisService } from '../utils/redis-service.js';
import { extractErrorDetails } from './error.js';
import { getLogger } from '../utils/logger.js';
import { LRUCache } from 'lru-cache';
import { retryWithBackoff } from './retry.js';
import { MAX_SWR_FAILURES, SWR_FAILURES_TTL_MS, SWR_FAILURES_TTL_SECONDS } from '../constants.js';

/** Metrics for Redis cache hit/miss/error tracking. */
export interface CacheMetrics {
  /** Number of successful cache reads */
  hits: number;
  /** Number of cache misses */
  misses: number;
  /** Number of cache read errors */
  errors: number;
  /** Number of stale-while-revalidate cache hits */
  swrHits: number;
  /** Number of stale-while-revalidate serving stale data */
  swrStale: number;
  /** Number of stale-while-revalidate errors */
  swrErrors: number;
}

const cacheMetrics: CacheMetrics = {
  hits: 0,
  misses: 0,
  errors: 0,
  swrHits: 0,
  swrStale: 0,
  swrErrors: 0,
};

/** Returns a snapshot of current cache metrics. */
export function getCacheMetrics(): CacheMetrics {
  return { ...cacheMetrics };
}

/** Resets all cache metrics counters to zero. */
export function resetCacheMetrics(): void {
  for (const key of Object.keys(cacheMetrics) as (keyof CacheMetrics)[]) {
    cacheMetrics[key] = 0;
  }
}

// SWR failure tracking uses Redis (`swr:failures:{key}`) with INCR/EXPIRE (5min TTL)
// for cross-instance consistency. Falls back to in-memory LRU if Redis is unavailable
// during revalidation — each process then tracks failures independently.
const SWR_FAILURES = new LRUCache<string, number>({
  max: 5000,
  ttl: SWR_FAILURES_TTL_MS,
  allowStale: false,
});

const inflightSimple = new Map<string, Promise<unknown>>();

/**
 * Reads from Redis cache, falling back to the fetcher on miss or error.
 * On miss, calls the fetcher and stores the result in Redis with the given TTL.
 * Handles corrupt cache entries gracefully by falling back to the fetcher.
 */
export async function withCache<T>(key: string, ttl: number, fetcher: () => Promise<T>): Promise<T> {
  const client = RedisService.getActiveClient();
  if (!client) return fetcher();

  try {
    const cached = await client.get(key);
    if (cached) {
      cacheMetrics.hits++;
      return JSON.parse(cached) as T;
    }
    cacheMetrics.misses++;
  } catch (err) {
    cacheMetrics.errors++;
    const details = extractErrorDetails(err);
    getLogger().warn({ err: details, key }, 'Cache read failed, falling back to DB');
  }

  const inflight = inflightSimple.get(key) as Promise<T> | undefined;
  if (inflight) return inflight;

  const promise = fetcher()
    .then(async (result) => {
      try {
        await client.set(key, JSON.stringify(result), 'EX', ttl);
      } catch (err) {
        const details = extractErrorDetails(err);
        getLogger().warn({ err: details, key }, 'Cache write failed');
      }
      return result;
    })
    .finally(() => inflightSimple.delete(key));

  inflightSimple.set(key, promise as Promise<unknown>);
  return promise;
}

const inflightPromises = new Map<string, Promise<unknown>>();

const INFLIGHT_TIMEOUT_MS = 30_000;

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

/**
 * Stale-while-revalidate cache pattern.
 * Returns cached data immediately (even if stale), then revalidates in the background.
 * Uses in-flight deduplication to prevent thundering herd on cache misses.
 * Implements a failure circuit breaker: after N consecutive revalidation failures,
 * serves stale data for up to 5 minutes before retrying.
 * Redis write failures during revalidation are silently ignored.
 */
export async function withStaleWhileRevalidate<T>(
  key: string,
  ttl: number,
  staleAfter: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const client = RedisService.getActiveClient();
  if (!client) return fetcher();

  const now = Date.now();

  try {
    const cached = await client.get(key);
    if (cached) {
      const entry: CacheEntry<T> = JSON.parse(cached);
      const isStale = now - entry.timestamp > staleAfter * 1000;

      if (!isStale) {
        cacheMetrics.swrHits++;
        return entry.data;
      }

      cacheMetrics.swrStale++;
      // Stale — serve immediately, revalidate in background
      if (!inflightPromises.get(key)) {
        const revalidatePromise = withTimeout(
          revalidateWithRetry(client, key, ttl, fetcher).finally(() => inflightPromises.delete(key)),
          INFLIGHT_TIMEOUT_MS
        );

        inflightPromises.set(key, revalidatePromise);
      }

      return entry.data;
    }
    cacheMetrics.misses++;
  } catch (err) {
    cacheMetrics.swrErrors++;
    const details = extractErrorDetails(err);
    getLogger().warn({ err: details, key }, 'SWR cache read failed, falling back to DB');
  }

  const existing = inflightPromises.get(key);
  if (existing) return (await existing) as T;

  const fetchPromise = withTimeout(
    revalidateWithRetry(client, key, ttl, fetcher).finally(() => inflightPromises.delete(key)),
    INFLIGHT_TIMEOUT_MS
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
  const failureKey = `swr:failures:${key}`;
  const failures = await getSwrFailureCount(client, failureKey);

  if (failures >= MAX_SWR_FAILURES) {
    SWR_FAILURES.delete(key);
    log.warn('SWR revalidation failing repeatedly, skipping retry');
    throw new Error('SWR revalidation limit exceeded');
  }

  try {
    const data = await retryWithBackoff(fetcher, { attempts: 2, baseDelayMs: 2000 });
    await clearSwrFailureCount(client, failureKey);
    SWR_FAILURES.delete(key);
    try {
      await client.set(key, JSON.stringify({ data, timestamp: Date.now() }), 'EX', ttl);
    } catch (writeErr) {
      log.warn({ err: extractErrorDetails(writeErr) }, 'SWR cache write failed');
    }
    return data;
  } catch (err) {
    await incrementSwrFailureCount(client, failureKey);
    SWR_FAILURES.set(key, failures + 1);
    log.error({ err: extractErrorDetails(err) }, 'SWR revalidation exhausted retries');
    throw err;
  }
}

async function getSwrFailureCount(
  client: ReturnType<typeof RedisService.getClient>,
  failureKey: string
): Promise<number> {
  try {
    const val = await client.get(failureKey);
    if (val) return parseInt(val, 10);
    return 0;
  } catch {
    return SWR_FAILURES.get(failureKey) ?? 0;
  }
}

async function incrementSwrFailureCount(
  client: ReturnType<typeof RedisService.getClient>,
  failureKey: string
): Promise<void> {
  try {
    const pipeline = client.pipeline();
    pipeline.incr(failureKey);
    pipeline.expire(failureKey, SWR_FAILURES_TTL_SECONDS);
    await pipeline.exec();
  } catch {
    const current = SWR_FAILURES.get(failureKey) ?? 0;
    SWR_FAILURES.set(failureKey, current + 1);
  }
}

async function clearSwrFailureCount(
  client: ReturnType<typeof RedisService.getClient>,
  failureKey: string
): Promise<void> {
  try {
    await client.del(failureKey);
  } catch {
    SWR_FAILURES.delete(failureKey);
  }
}
