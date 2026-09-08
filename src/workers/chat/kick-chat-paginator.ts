import dayjs from 'dayjs';
import pLimit from 'p-limit';
import { RateLimiterRes } from 'rate-limiter-flexible';
import { Kick } from '../../constants.ts';
import { type KickChatMessage, KickChatWaterfallClient } from '../../services/kick/chat.ts';
import { jitter, sleep } from '../../utils/delay.ts';
import { RateLimitedError } from '../../utils/domain-errors.ts';
import type { AppLogger } from '../../utils/logger.ts';
import { RedisService } from '../../utils/redis-service.ts';

const KICK_CHAT_LIMITER_KEY = 'rate:kick:chat';

/**
 * Process-wide throttle for Kick chat fetches. When any bucket gets a 429, a shared
 * "quiet until" instant is set so every in-flight task waits before its next
 * request — preventing a simultaneous burst of requests from re-triggering the
 * rate limit (thundering herd).
 */
let throttleUntil = 0;

/** Reset the shared throttle window (test-only). */
export function resetKickChatThrottleForTests(): void {
  throttleUntil = 0;
}

function isRateLimitedError(err: unknown): boolean {
  if (err instanceof RateLimitedError) return true;
  // The FlareSolverr fallback surfaces 429s as plain errors ("FlareSolverr failed: HTTP 429").
  // Word boundaries so unrelated numbers containing "429" (offsets, positions) never match.
  const msg = err instanceof Error ? err.message : String(err);
  return /\b429\b/.test(msg);
}

/** Backoff delay for a given 429 attempt, honoring Retry-After when it exceeds the backoff. */
function rateLimitDelayMs(err: unknown, attempt: number): number {
  const backoff = Math.min(Kick.CHAT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), Kick.CHAT_RETRY_MAX_DELAY_MS);
  const retryAfterMs = err instanceof RateLimitedError ? err.retryAfterMs : undefined;
  if (retryAfterMs != null && retryAfterMs > 0) {
    return Math.max(retryAfterMs, backoff);
  }
  return jitter(backoff);
}

async function awaitThrottleWindow(log: AppLogger): Promise<void> {
  const waitMs = throttleUntil - Date.now();
  if (waitMs <= 0) return;
  log.debug({ waitMs: Math.ceil(waitMs) }, 'Waiting for shared Kick rate-limit throttle window to clear');
  await sleep(waitMs);
}

async function acquireRequestSlot(log: AppLogger): Promise<void> {
  const limiter = RedisService.getLimiter(KICK_CHAT_LIMITER_KEY);
  if (limiter == null) return;

  for (;;) {
    try {
      // consume() rejects with a RateLimiterRes when the window's points are
      // exhausted (the rejected call has already burned a point). Wait until
      // the window frees up and retry — never let this rejection reach the
      // bucket, or its messages would be silently dropped.
      await limiter.consume(KICK_CHAT_LIMITER_KEY);
      return;
    } catch (err: unknown) {
      if (err instanceof RateLimiterRes) {
        log.debug({ msBeforeNext: err.msBeforeNext }, 'Waiting for the global Kick chat rate limit window to free up');
        // Floor the wait so a zero/absent msBeforeNext can never spin this loop against Redis.
        await sleep(Math.max(err.msBeforeNext, 500));
        continue;
      }
      throw err;
    }
  }
}

/** Thrown when a bucket exhausts all 429 retries; propagates to fail the job so it can be resumed. */
class BucketRetriesExhaustedError extends Error {
  constructor(offset: number, cause: string) {
    super(`Kick chat rate limited at offset ${offset} after ${Kick.CHAT_RETRY_MAX_ATTEMPTS} attempts: ${cause}`);
    this.name = 'BucketRetriesExhaustedError';
  }
}

async function fetchBucketWithRetry(
  client: KickChatWaterfallClient,
  channelId: number | string,
  offset: number,
  fetchTime: string,
  log: AppLogger
): Promise<KickChatMessage[]> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= Kick.CHAT_RETRY_MAX_ATTEMPTS; attempt++) {
    await awaitThrottleWindow(log);
    await acquireRequestSlot(log);

    try {
      const rawPage = await client.fetchPage(channelId, fetchTime);
      return rawPage?.data?.messages ?? [];
    } catch (err: unknown) {
      if (!isRateLimitedError(err)) {
        throw err;
      }

      lastError = err;
      const delayMs = rateLimitDelayMs(err, attempt);
      throttleUntil = Math.max(throttleUntil, Date.now() + delayMs);
      log.warn({ offset, attempt, delayMs }, 'Kick chat fetch hit 429 rate limit — backing off');
      await sleep(throttleUntil - Date.now());
    }
  }

  const cause = lastError instanceof Error ? lastError.message : String(lastError);
  throw new BucketRetriesExhaustedError(offset, cause);
}

export async function* paginateKickChatCommentsParallel(
  channelId: number | string,
  vodCreatedAt: dayjs.Dayjs,
  durationSeconds: number,
  startOffsetSeconds: number,
  logger: AppLogger
): AsyncGenerator<KickChatMessage[]> {
  const client = new KickChatWaterfallClient(channelId, logger);

  const CONCURRENCY = Kick.CHAT_FETCH_CONCURRENCY;
  const CHUNK_SIZE = Kick.CHAT_FETCH_CHUNK_SIZE;
  const STEP_SECONDS = Kick.CHAT_FETCH_STEP_SECONDS;

  // Snap base time to nearest 5-second floor
  const alignedStart = vodCreatedAt.second(Math.floor(vodCreatedAt.second() / 5) * 5);

  // Ensure startOffset is aligned to 5-second boundary
  const startOffset = Math.floor(startOffsetSeconds / 5) * 5;

  // Pre-calculate all offsets to be fetched
  const allOffsets: number[] = [];
  for (let offset = startOffset; offset <= durationSeconds; offset += STEP_SECONDS) {
    allOffsets.push(offset);
  }

  logger.info(
    { channelId, totalSlots: allOffsets.length, concurrency: CONCURRENCY },
    'Starting Kick chat fetch (Parallel + Chunked)'
  );

  const limit = pLimit(CONCURRENCY);

  try {
    // Process in bounded chunks so we don't load millions of messages into memory
    for (let i = 0; i < allOffsets.length; i += CHUNK_SIZE) {
      const offsetChunk = allOffsets.slice(i, i + CHUNK_SIZE);

      const promises = offsetChunk.map((offset) =>
        limit(async () => {
          // Build ISO timestamp for Kick API
          const fetchTime = alignedStart.add(offset, 'second').toISOString();

          try {
            return await fetchBucketWithRetry(client, channelId, offset, fetchTime, logger);
          } catch (err: unknown) {
            if (err instanceof BucketRetriesExhaustedError) {
              // Fail loudly — BullMQ retries the job and resumes from the last
              // persisted offset, so no chat data is silently lost.
              throw err;
            }

            const msg = err instanceof Error ? err.message : String(err);
            logger.error({ offset, err: msg }, 'Failed to fetch parallel bucket');
            return [];
          }
        })
      );

      const results = await Promise.all(promises);

      // Flatten and sort strictly by creation time
      const flattenedMessages = results.flat();

      if (flattenedMessages.length > 0) {
        flattenedMessages.sort((a, b) => {
          const aTime = dayjs.utc(a.created_at).valueOf();
          const bTime = dayjs.utc(b.created_at).valueOf();
          return aTime - bTime;
        });
        yield flattenedMessages;
      }
    }
  } finally {
    client.close();
  }
}
