/**
 * Cache utilities module.
 *
 * Two cache strategies are available — choose based on your latency requirements:
 *
 * **`withCache`** — Simple read-through cache with compressed storage.
 * Use for data that must always be fresh on cache miss. Supports primitives, objects, and arrays.
 * Includes inflight deduplication and cache metrics tracking.
 * Key type: `SimpleKey` (via `simpleKeys.*` helpers).
 *
 * **`withStaleWhileRevalidate`** — SWR cache that returns stale data immediately while
 * revalidating in the background. Use for expensive queries where slightly stale data is acceptable.
 * Includes failure circuit breaker, retry-with-backoff, and inflight deduplication.
 * Key type: `SWRKey` (via `swrKeys.*` helpers).
 *
 * Both use Brotli compression internally — primitives like numbers round-trip correctly.
 * The `withSimpleCache` function has been removed; use `withCache` for all use cases.
 */
import { LRUCache } from 'lru-cache';
import { CacheSwr, CacheInflight } from '../constants.js';
import { getLogger } from '../utils/logger.js';
import { RedisService } from '../utils/redis-service.js';
import type { SWRKey, SimpleKey } from './cache-keys.js';
import { compressData, decompressData } from './compression.js';
import { extractErrorDetails } from './error.js';
import { retryWithBackoff } from './retry.js';

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

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const emptyMetrics = (): CacheMetrics => ({
  hits: 0,
  misses: 0,
  errors: 0,
  swrHits: 0,
  swrStale: 0,
  swrErrors: 0,
});

function isCacheEntry(raw: unknown): raw is CacheEntry<unknown> {
  if (raw == null || typeof raw !== 'object') return false;
  const obj = raw as Record<string, unknown>;
  return typeof obj.timestamp === 'number' && obj.data !== undefined;
}

/**
 * Owns all mutable cache state: metrics, SWR failure tracking, and inflight deduplication.
 * Use the default export for production, or construct a fresh instance per test case.
 */
export class CacheContext {
  private readonly metrics: CacheMetrics = emptyMetrics();
  private readonly swrFailures = new LRUCache<string, number>({
    max: 5000,
    ttl: CacheSwr.FAILURES_TTL_MS,
    allowStale: false,
  });
  private readonly inflight = new LRUCache<string, Promise<unknown>>({
    max: CacheInflight.CACHE_MAX,
    ttl: CacheInflight.TIMEOUT_MS,
    allowStale: false,
  });

  getMetrics(): Readonly<CacheMetrics> {
    return { ...this.metrics };
  }

  /** Resets metrics to zero and clears both caches. */
  reset(): void {
    Object.assign(this.metrics, emptyMetrics());
    this.swrFailures.clear();
    this.inflight.clear();
  }

  async withCache<T>(key: SimpleKey, ttl: number, fetcher: () => Promise<T>): Promise<T> {
    const client = RedisService.getActiveClient();
    if (!client) return fetcher();

    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;

    try {
      const cached = await client.getBuffer(key);
      if (cached != null && cached.length > 0) {
        const parsed: unknown = await decompressData(cached);
        if (isCacheEntry(parsed)) {
          this.metrics.misses++;
          getLogger().debug({ key }, 'Cache miss: unexpected SWR-format entry in simple cache');
          return fetcher();
        }
        this.metrics.hits++;
        return parsed as T;
      }
      this.metrics.misses++;
    } catch (err) {
      this.metrics.errors++;
      const details = extractErrorDetails(err);
      getLogger().warn({ err: details, key }, 'Cache read failed, falling back to DB');
    }

    const inflight = this.inflight.get(key) as Promise<T> | undefined;
    if (inflight) return inflight;

    const promise = fetcher()
      .then(async (result) => {
        try {
          const compressed = await compressData(result);
          await client.set(key, compressed, 'EX', ttl);
        } catch (err) {
          const details = extractErrorDetails(err);
          getLogger().warn({ err: details, key }, 'Cache write failed');
        }
        return result;
      })
      .finally(() => this.inflight.delete(key));

    this.inflight.set(key, promise);
    return promise;
  }

  async withStaleWhileRevalidate<T>(
    key: SWRKey,
    ttl: number,
    staleAfter: number,
    fetcher: () => Promise<T>
  ): Promise<T> {
    const client = RedisService.getActiveClient();
    if (!client) return fetcher();

    const now = Date.now();

    try {
      const cached = await client.getBuffer(key);
      if (cached != null && cached.length > 0) {
        const parsed: unknown = await decompressData(cached);
        if (!isCacheEntry(parsed)) {
          this.metrics.misses++;
          getLogger().debug({ key }, 'Cache miss: unexpected simple-format entry in SWR cache');
          return fetcher();
        }
        const entry = parsed as CacheEntry<T>;
        const isStale = now - entry.timestamp > staleAfter * 1000;

        if (!isStale) {
          this.metrics.swrHits++;
          return entry.data;
        }

        this.metrics.swrStale++;
        // Stale — serve immediately, revalidate in background
        if (!this.inflight.get(key)) {
          const revalidatePromise = this.withTimeout(
            this.revalidateWithRetry(client, key, ttl, fetcher).finally(() => this.inflight.delete(key)),
            CacheInflight.TIMEOUT_MS
          );

          this.inflight.set(key, revalidatePromise);
        }

        return entry.data;
      }
      this.metrics.misses++;
    } catch (err) {
      this.metrics.swrErrors++;
      const details = extractErrorDetails(err);
      getLogger().warn({ err: details, key }, 'SWR cache read failed, falling back to DB');
    }

    const existing = this.inflight.get(key);
    if (existing) return (await existing) as T;

    const fetchPromise = this.withTimeout(
      this.revalidateWithRetry(client, key, ttl, fetcher).finally(() => this.inflight.delete(key)),
      CacheInflight.TIMEOUT_MS
    );

    this.inflight.set(key, fetchPromise);
    return await fetchPromise;
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`In-flight fetch timed out after ${ms}ms`));
        }, ms);
      }),
    ]);
  }

  private async revalidateWithRetry<T>(
    client: ReturnType<typeof RedisService.getClient>,
    key: string,
    ttl: number,
    fetcher: () => Promise<T>
  ): Promise<T> {
    const log = getLogger().child({ key });
    const failureKey = `swr:failures:${key}`;
    const failures = await this.getSwrFailureCount(client, failureKey);

    if (failures >= CacheSwr.MAX_FAILURES) {
      this.swrFailures.delete(key);
      log.warn('SWR revalidation failing repeatedly, skipping retry');
      throw new Error('SWR revalidation limit exceeded');
    }

    try {
      const data = await retryWithBackoff(fetcher, { attempts: 2, baseDelayMs: 2000 });
      await this.clearSwrFailureCount(client, failureKey);
      this.swrFailures.delete(key);
      try {
        const compressed = await compressData({ data, timestamp: Date.now() });
        await client.set(key, compressed, 'EX', ttl);
      } catch (writeErr) {
        log.warn({ err: extractErrorDetails(writeErr) }, 'SWR cache write failed');
      }
      return data;
    } catch (err) {
      await this.incrementSwrFailureCount(client, failureKey);
      this.swrFailures.set(key, failures + 1);
      log.error({ err: extractErrorDetails(err) }, 'SWR revalidation exhausted retries');
      throw err;
    }
  }

  private async getSwrFailureCount(
    client: ReturnType<typeof RedisService.getClient>,
    failureKey: string
  ): Promise<number> {
    try {
      const val = await client.get(failureKey);
      if (val != null && val !== '') return parseInt(val, 10);
      return 0;
    } catch {
      return this.swrFailures.get(failureKey) ?? 0;
    }
  }

  private async incrementSwrFailureCount(
    client: ReturnType<typeof RedisService.getClient>,
    failureKey: string
  ): Promise<void> {
    try {
      const pipeline = client.pipeline();
      pipeline.incr(failureKey);
      pipeline.expire(failureKey, CacheSwr.FAILURES_TTL_MS / 1_000);
      await pipeline.exec();
    } catch {
      const current = this.swrFailures.get(failureKey) ?? 0;
      this.swrFailures.set(failureKey, current + 1);
    }
  }

  private async clearSwrFailureCount(
    client: ReturnType<typeof RedisService.getClient>,
    failureKey: string
  ): Promise<void> {
    try {
      await client.del(failureKey);
    } catch {
      this.swrFailures.delete(failureKey);
    }
  }
}

/** Default singleton for production use. */
export const defaultCacheContext = new CacheContext();

/**
 * Reads from Redis cache, falling back to the fetcher on miss or error.
 * On miss, calls the fetcher and stores the result in Redis with the given TTL.
 * Handles corrupt cache entries gracefully by falling back to the fetcher.
 * Namespaces are physically separated (simple: prefix) so SWR entries won't collide,
 * but the defensive check remains as a safety net for manual Redis operations.
 */
export async function withCache<T>(
  key: SimpleKey,
  ttl: number,
  fetcher: () => Promise<T>,
  ctx: CacheContext = defaultCacheContext
): Promise<T> {
  return ctx.withCache(key, ttl, fetcher);
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
  fetcher: () => Promise<T>,
  ctx: CacheContext = defaultCacheContext
): Promise<T> {
  return ctx.withStaleWhileRevalidate(key, ttl, staleAfter, fetcher);
}
