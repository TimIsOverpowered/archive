import { strict as assert } from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';
import { RateLimiterRes } from 'rate-limiter-flexible';
import { Kick } from '../../../src/constants.ts';
import type { KickChatMessage } from '../../../src/services/kick/chat.ts';
import dayjs from '../../../src/utils/dayjs.ts';
import { RateLimitedError } from '../../../src/utils/domain-errors.ts';
import type { AppLogger } from '../../../src/utils/logger.ts';

const fakeLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
} as unknown as AppLogger;

// ── Module mocks (registered before the SUT is imported) ────────────────────

// Real sleep driven by (mockable) setTimeout; deterministic jitter so backoff
// delays are exact.
mock.module('../../../src/utils/delay.js', {
  namedExports: {
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    jitter: (value: number) => value,
    getRetryDelay: (retryCount: number, baseDelayMs: number = 60000) => retryCount * baseDelayMs,
  },
});

interface MockCall {
  startTime: string;
  at: number;
}

class MockKickChatWaterfallClient {
  static instances: MockKickChatWaterfallClient[] = [];
  closed = false;
  readonly calls: MockCall[] = [];

  constructor(readonly channelId: number | string) {
    MockKickChatWaterfallClient.instances.push(this);
  }

  async fetchPage(_channelId: number | string, startTime: string): Promise<unknown> {
    this.calls.push({ startTime, at: Date.now() });
    const queue = behaviorsByStartTime.get(startTime);
    const behavior = queue?.shift();
    if (behavior instanceof Error) throw behavior;
    if (typeof behavior === 'function') return await behavior();
    if (behavior != null) return behavior;
    return { data: { messages: [] } };
  }

  close(): void {
    this.closed = true;
  }
}

mock.module('../../../src/services/kick/chat.js', {
  namedExports: {
    KickChatWaterfallClient: MockKickChatWaterfallClient,
  },
});

const consumeCalls: string[] = [];
const limiterState: { limiter: { consume: (key: string) => Promise<unknown> } | null } = { limiter: null };

mock.module('../../../src/utils/redis-service.js', {
  namedExports: {
    RedisService: {
      getLimiter: () => limiterState.limiter,
    },
  },
});

// System Under Test — dynamically imported AFTER mock.module registrations.
const { paginateKickChatCommentsParallel, resetKickChatThrottleForTests } = await import(
  '../../../src/workers/chat/kick-chat-paginator.ts'
);

// ── Helpers ──────────────────────────────────────────────────────────────────

const VOD_CREATED_AT = dayjs.utc('2026-01-15T12:00:00.000Z');

/** Scripted behaviors per requested start_time, consumed in order. */
const behaviorsByStartTime = new Map<string, unknown[]>();

function startTimeFor(offsetSeconds: number): string {
  return VOD_CREATED_AT.add(offsetSeconds, 'second').toISOString();
}

function messageAt(id: string, offsetSeconds: number): Record<string, unknown> {
  return { id, content: `message ${id}`, created_at: VOD_CREATED_AT.add(offsetSeconds, 'second').toISOString() };
}

async function collectBatches(): Promise<KickChatMessage[][]> {
  const batches: KickChatMessage[][] = [];
  for await (const batch of paginateKickChatCommentsParallel('chan-1', VOD_CREATED_AT, 10, 0, fakeLogger)) {
    batches.push(batch);
  }
  return batches;
}

/**
 * Advance the mocked clock in small steps, draining the microtask queue between
 * steps so that promise continuations scheduled by timer callbacks can schedule
 * further timers (which a single synchronous tick would miss).
 */
async function advanceTime(ms: number, stepMs = 100): Promise<void> {
  for (let remaining = ms; remaining > 0; remaining -= stepMs) {
    const step = Math.min(stepMs, remaining);
    mock.timers.tick(step);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function getMockClient(): MockKickChatWaterfallClient {
  const client = MockKickChatWaterfallClient.instances[0];
  assert.ok(client, 'expected a mock KickChatWaterfallClient instance');
  return client;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('paginateKickChatCommentsParallel', () => {
  beforeEach(() => {
    behaviorsByStartTime.clear();
    consumeCalls.length = 0;
    limiterState.limiter = null;
    MockKickChatWaterfallClient.instances.length = 0;
    resetKickChatThrottleForTests();
  });

  it('yields flattened and sorted messages', async () => {
    // Deliberately out of order across buckets to verify sorting.
    behaviorsByStartTime.set(startTimeFor(0), [{ data: { messages: [messageAt('0-1', 4), messageAt('0-0', 0)] } }]);
    behaviorsByStartTime.set(startTimeFor(5), [{ data: { messages: [messageAt('5-0', 3), messageAt('5-1', 5)] } }]);

    const batches = await collectBatches();

    assert.strictEqual(batches.length, 1);
    // Sorted by created_at: t0 (0-0), t3 (5-0), t4 (0-1), t5 (5-1)
    assert.deepStrictEqual(
      batches[0]?.map((m) => m.id),
      ['0-0', '5-0', '0-1', '5-1']
    );
    assert.strictEqual(getMockClient().closed, true);
  });

  it('gates every request through the global rate limiter', async () => {
    limiterState.limiter = {
      consume: async (key: string) => {
        consumeCalls.push(key);
      },
    };

    await collectBatches();

    // duration 10 → offsets 0, 5, 10 → exactly 3 requests
    assert.deepStrictEqual(consumeCalls, ['rate:kick:chat', 'rate:kick:chat', 'rate:kick:chat']);
  });

  it('waits out the limiter window when consume() rejects instead of dropping the bucket', async () => {
    let attempts = 0;
    limiterState.limiter = {
      consume: async (_key: string) => {
        attempts++;
        if (attempts <= 2) {
          // Mirrors rate-limiter-flexible: the window is exhausted and the
          // rejected call has already burned a point.
          throw new RateLimiterRes(0, 50, attempts);
        }
      },
    };
    behaviorsByStartTime.set(startTimeFor(0), [{ data: { messages: [messageAt('0-0', 0)] } }]);

    const batches = await collectBatches();

    // The rejected consumes must be retried after the wait — the bucket's
    // messages must still come back, not be silently dropped.
    assert.ok(attempts >= 5, `expected consume() retries after rejection, got ${attempts} attempts`);
    assert.strictEqual(batches.length, 1);
    assert.strictEqual(batches[0]?.[0]?.id, '0-0');
    assert.strictEqual(getMockClient().closed, true);
  });

  it('applies a minimum wait when the limiter reports no next window', async () => {
    let attempts = 0;
    limiterState.limiter = {
      consume: async () => {
        attempts++;
        if (attempts <= 2) {
          throw new RateLimiterRes(0, 0, attempts);
        }
      },
    };
    behaviorsByStartTime.set(startTimeFor(0), [{ data: { messages: [messageAt('0-0', 0)] } }]);

    // Single bucket (duration 4 → only offset 0) so the waits are sequential.
    const startedAt = Date.now();
    const batches: KickChatMessage[][] = [];
    for await (const batch of paginateKickChatCommentsParallel('chan-1', VOD_CREATED_AT, 4, 0, fakeLogger)) {
      batches.push(batch);
    }

    // Two zero msBeforeNext rejections must still wait at least 2 × 500ms.
    assert.strictEqual(attempts, 3);
    assert.ok(Date.now() - startedAt >= 1000, `expected >= 1000ms of minimum waits, got ${Date.now() - startedAt}ms`);
    assert.strictEqual(batches.length, 1);
    assert.strictEqual(batches[0]?.[0]?.id, '0-0');
  });

  it('does not treat a 429 substring in an unrelated error as a rate limit', async () => {
    behaviorsByStartTime.set(startTimeFor(0), [new Error('Unexpected token in JSON at position 14290')]);

    const batches = await collectBatches();

    // Not a rate limit → no backoff retry; the bucket is skipped (existing behavior)
    // and the job does not fail.
    const client = getMockClient();
    assert.strictEqual(client.calls.filter((c) => c.startTime === startTimeFor(0)).length, 1);
    assert.strictEqual(batches.length, 0);
    assert.strictEqual(client.closed, true);
  });

  it('retries a 429 bucket and recovers the messages', async () => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    try {
      behaviorsByStartTime.set(startTimeFor(0), [
        new RateLimitedError('Impit request rate limited with status 429'),
        { data: { messages: [messageAt('0-0', 0)] } },
      ]);

      const gen = paginateKickChatCommentsParallel('chan-1', VOD_CREATED_AT, 4, 0, fakeLogger);
      const batches: KickChatMessage[][] = [];
      const collector = (async () => {
        for await (const batch of gen) batches.push(batch);
      })();
      await advanceTime(Kick.CHAT_RETRY_BASE_DELAY_MS + 5000);
      await collector;

      const client = getMockClient();
      assert.deepStrictEqual(
        client.calls.map((c) => c.startTime),
        [startTimeFor(0), startTimeFor(0)]
      );
      assert.strictEqual(batches.length, 1);
      assert.strictEqual(batches[0]?.[0]?.id, '0-0');
      assert.strictEqual(client.closed, true);
    } finally {
      mock.timers.reset();
    }
  });

  it('honors Retry-After when it exceeds the computed backoff', async () => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    try {
      const retryAfterMs = 45_000;
      behaviorsByStartTime.set(startTimeFor(0), [
        new RateLimitedError('Impit request rate limited with status 429', retryAfterMs),
        { data: { messages: [messageAt('0-0', 0)] } },
      ]);

      const gen = paginateKickChatCommentsParallel('chan-1', VOD_CREATED_AT, 4, 0, fakeLogger);
      const promise = gen.next();
      await advanceTime(retryAfterMs + 5000);
      const { done } = await promise;
      assert.strictEqual(done, false);

      const client = getMockClient();
      const first = client.calls[0];
      const second = client.calls[1];
      assert.ok(first && second, 'expected two fetch attempts');
      assert.ok(
        second.at - first.at >= retryAfterMs - 100,
        `expected retry after >= ${retryAfterMs}ms, got ${second.at - first.at}ms`
      );
    } finally {
      mock.timers.reset();
    }
  });

  it('pauses all in-flight buckets when any of them is rate limited (shared throttle window)', async () => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    try {
      const retryAfterMs = 20_000;

      // Bucket 5 hits 429 immediately → its own backoff is 15s.
      behaviorsByStartTime.set(startTimeFor(5), [
        new RateLimitedError('Impit request rate limited with status 429'),
        { data: { messages: [messageAt('5-0', 5)] } },
      ]);
      // Bucket 0 is slow, then hits 429 with a longer Retry-After → shared window becomes 20s.
      behaviorsByStartTime.set(startTimeFor(0), [
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          throw new RateLimitedError('Impit request rate limited with status 429', retryAfterMs);
        },
        { data: { messages: [messageAt('0-0', 0)] } },
      ]);

      const gen = paginateKickChatCommentsParallel('chan-1', VOD_CREATED_AT, 5, 0, fakeLogger);
      const promise = gen.next();
      await advanceTime(60_000);
      const { done, value } = await promise;
      assert.strictEqual(done, false);
      assert.strictEqual(value.length, 2);

      const client = getMockClient();
      const bucket5Calls = client.calls.filter((c) => c.startTime === startTimeFor(5));
      const bucket0Calls = client.calls.filter((c) => c.startTime === startTimeFor(0));
      assert.strictEqual(bucket5Calls.length, 2);
      assert.strictEqual(bucket0Calls.length, 2);

      // Bucket 5's own backoff was 15s, but its retry waited out bucket 0's 20s
      // Retry-After window — proving the throttle is shared across in-flight tasks.
      const startedAt = client.calls[0]?.at ?? 0;
      const bucket5RetryAt = bucket5Calls[1]?.at ?? 0;
      assert.ok(
        bucket5RetryAt - startedAt >= retryAfterMs - 100,
        `expected bucket 5 retry at >= ${retryAfterMs}ms after start, got ${bucket5RetryAt - startedAt}ms`
      );
    } finally {
      mock.timers.reset();
    }
  });

  it('fails the job after exhausting retries instead of dropping the bucket', async () => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    try {
      const queue: unknown[] = [];
      for (let i = 0; i < Kick.CHAT_RETRY_MAX_ATTEMPTS; i++) {
        queue.push(new RateLimitedError('Impit request rate limited with status 429'));
      }
      behaviorsByStartTime.set(startTimeFor(0), queue);

      const runner = (async () => {
        const gen = paginateKickChatCommentsParallel('chan-1', VOD_CREATED_AT, 4, 0, fakeLogger);
        for await (const _batch of gen) {
          // unreachable
        }
      })();
      // Attach the rejection handler before advancing time so the rejection is
      // never observed as unhandled.
      const assertion = assert.rejects(runner, /Kick chat rate limited at offset 0 after \d+ attempts/);
      await advanceTime(600_000);
      await assertion;

      const client = getMockClient();
      assert.strictEqual(client.calls.length, Kick.CHAT_RETRY_MAX_ATTEMPTS);
      assert.strictEqual(client.closed, true);
    } finally {
      mock.timers.reset();
    }
  });
});
