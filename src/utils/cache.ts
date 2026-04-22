import { RedisService } from '../utils/redis-service.js';
import { extractErrorDetails } from './error.js';
import { getLogger } from '../utils/logger.js';
import { LRUCache } from 'lru-cache';
import { retryWithBackoff } from './retry.js';
import { MAX_SWR_FAILURES, SWR_FAILURES_TTL_MS } from '../constants.js';

// SWR failure tracking uses Redis (`swr:failures:{key}`) with INCR/EXPIRE (5min TTL)
// for cross-instance consistency. All instances share the same failure threshold.
// Falls back to in-memory LRU if Redis is unavailable during revalidation.
const SWR_FAILURES = new LRUCache<string, number>({
  max: 5000,
  ttl: SWR_FAILURES_TTL_MS,
  allowStale: false,
});

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
  const client = RedisService.getActiveClient();
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
  const client = RedisService.getActiveClient();
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
  const failureKey = `swr:failures:${key}`;
  const failures = await getSwrFailureCount(client, failureKey);

  if (failures >= MAX_SWR_FAILURES) {
    SWR_FAILURES.delete(key);
    inflightPromises.delete(key);
    log.warn('SWR revalidation failing repeatedly, skipping retry');
    throw new Error('SWR revalidation limit exceeded');
  }

  try {
    const data = await retryWithBackoff(fetcher, { attempts: 2, baseDelayMs: 2000 });
    await clearSwrFailureCount(client, failureKey);
    SWR_FAILURES.delete(key);
    await client.set(key, JSON.stringify({ data, timestamp: Date.now() }), 'EX', ttl);
    inflightPromises.delete(key);
    return data;
  } catch (err) {
    await incrementSwrFailureCount(client, failureKey);
    SWR_FAILURES.set(key, failures + 1);
    inflightPromises.delete(key);
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
    pipeline.expire(failureKey, Math.ceil(SWR_FAILURES_TTL_MS / 1000));
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
