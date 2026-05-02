/**
 * Cache utilities module.
 *
 * Two cache strategies are available — choose based on your latency requirements:
 *
 * **`withCache`** — Simple read-through cache with JSON serialization.
 * Use for data that must always be fresh on cache miss. Supports primitives, objects, and arrays.
 * Includes inflight deduplication and cache metrics tracking.
 * Key type: `SimpleKey` (via `simpleKeys.*` helpers).
 *
 * **`withStaleWhileRevalidate`** — SWR cache that returns stale data immediately while
 * revalidating in the background. Use for expensive queries where slightly stale data is acceptable.
 * Includes failure circuit breaker, retry-with-backoff, and inflight deduplication.
 * Key type: `SWRKey` (via `swrKeys.*` helpers).
 *
 * Both use `JSON.parse`/`JSON.stringify` internally — primitives like numbers round-trip correctly.
 * The `withSimpleCache` function has been removed; use `withCache` for all use cases.
 */
import { RedisService } from '../utils/redis-service.js';
import { extractErrorDetails } from './error.js';
import { getLogger } from '../utils/logger.js';
import { LRUCache } from 'lru-cache';
import { retryWithBackoff } from './retry.js';
import { CacheSwr, CacheInflight } from '../constants.js';
import type { SWRKey, SimpleKey } from './cache-keys.js';

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
  ttl: CacheSwr.FAILURES_TTL_MS,
  allowStale: false,
});

const globalInflight = new LRUCache<string, Promise<unknown>>({
  max: CacheInflight.CACHE_MAX,
  ttl: CacheInflight.TIMEOUT_MS,
  allowStale: false,
});

function isCacheEntry(raw: unknown): raw is CacheEntry<unknown> {
  if (raw == null || typeof raw !== 'object') return false;
  const obj = raw as Record<string, unknown>;
  return typeof obj.timestamp === 'number' && obj.data !== undefined;
}

/**
 * Reads from Redis cache, falling back to the fetcher on miss or error.
 * On miss, calls the fetcher and stores the result in Redis with the given TTL.
 * Handles corrupt cache entries gracefully by falling back to the fetcher.
 * Namespaces are physically separated (simple: prefix) so SWR entries won't collide,
 * but the defensive check remains as a safety net for manual Redis operations.
 */
export async function withCache<T>(key: SimpleKey, ttl: number, fetcher: () => Promise<T>): Promise<T> {
  const client = RedisService.getActiveClient();
  if (!client) return fetcher();

  try {
    const cached = await client.get(key);
    if (cached != null && cached !== '') {
      const parsed: unknown = JSON.parse(cached);
      if (isCacheEntry(parsed)) {
        cacheMetrics.misses++;
        getLogger().debug({ key }, 'Cache miss: unexpected SWR-format entry in simple cache');
        return fetcher();
      }
      cacheMetrics.hits++;
      return parsed as T;
    }
    cacheMetrics.misses++;
  } catch (err) {
    cacheMetrics.errors++;
    const details = extractErrorDetails(err);
    getLogger().warn({ err: details, key }, 'Cache read failed, falling back to DB');
  }

  const inflight = globalInflight.get(key) as Promise<T> | undefined;
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
    .finally(() => globalInflight.delete(key));

  globalInflight.set(key, promise);
  return promise;
}

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
  key: SWRKey,
  ttl: number,
  staleAfter: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const client = RedisService.getActiveClient();
  if (!client) return fetcher();

  const now = Date.now();

  try {
    const cached = await client.get(key);
    if (cached != null && cached !== '') {
      const parsed: unknown = JSON.parse(cached);
      if (!isCacheEntry(parsed)) {
        cacheMetrics.misses++;
        getLogger().debug({ key }, 'Cache miss: unexpected simple-format entry in SWR cache');
        return fetcher();
      }
      const entry = parsed as CacheEntry<T>;
      const isStale = now - entry.timestamp > staleAfter * 1000;

      if (!isStale) {
        cacheMetrics.swrHits++;
        return entry.data;
      }

      cacheMetrics.swrStale++;
      // Stale — serve immediately, revalidate in background
      if (!globalInflight.get(key)) {
        const revalidatePromise = withTimeout(
          revalidateWithRetry(client, key, ttl, fetcher).finally(() => globalInflight.delete(key)),
          CacheInflight.TIMEOUT_MS
        );

        globalInflight.set(key, revalidatePromise);
      }

      return entry.data;
    }
    cacheMetrics.misses++;
  } catch (err) {
    cacheMetrics.swrErrors++;
    const details = extractErrorDetails(err);
    getLogger().warn({ err: details, key }, 'SWR cache read failed, falling back to DB');
  }

  const existing = globalInflight.get(key);
  if (existing) return (await existing) as T;

  const fetchPromise = withTimeout(
    revalidateWithRetry(client, key, ttl, fetcher).finally(() => globalInflight.delete(key)),
    CacheInflight.TIMEOUT_MS
  );

  globalInflight.set(key, fetchPromise);
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

  if (failures >= CacheSwr.MAX_FAILURES) {
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
    if (val != null && val !== '') return parseInt(val, 10);
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
    pipeline.expire(failureKey, CacheSwr.FAILURES_TTL_SECONDS);
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
