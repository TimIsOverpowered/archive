import { strict as assert } from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';
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

let fetchTextImpl: (url: string) => Promise<string>;

const fakeSession = {
  fetchText: (url: string) => fetchTextImpl(url),
  close: () => {},
};

mock.module('../../../src/utils/impit-wrapper.js', {
  namedExports: {
    createSession: () => fakeSession,
  },
});

let flareResult: unknown = {
  success: true,
  data: { data: { messages: [{ id: 'flare-1', created_at: '2026-01-15T12:00:00Z' }] } },
};

mock.module('../../../src/utils/flaresolverr-client.js', {
  namedExports: {
    fetchUrl: async () => flareResult,
  },
});

// System Under Test — dynamically imported AFTER mock.module registrations.
const { KickChatWaterfallClient } = await import('../../../src/services/kick/chat.ts');

// ── Tests ────────────────────────────────────────────────────────────────────

describe('KickChatWaterfallClient', () => {
  beforeEach(() => {
    flareResult = { success: true, data: { data: { messages: [] } } };
  });

  it('returns parsed JSON on success', async () => {
    fetchTextImpl = async () =>
      JSON.stringify({ data: { messages: [{ id: '1', created_at: '2026-01-15T12:00:00Z' }] } });

    const client = new KickChatWaterfallClient('chan-1', fakeLogger);
    const result = await client.fetchPage('chan-1', '2026-01-15T12:00:00.000Z');

    assert.ok(result != null);
    assert.strictEqual(result.data?.messages?.[0]?.id, '1');
  });

  it('rethrows RateLimitedError with retryAfterMs intact', async () => {
    const rateLimitError = new RateLimitedError('Impit request rate limited with status 429', 30_000);
    fetchTextImpl = async () => {
      throw rateLimitError;
    };

    const client = new KickChatWaterfallClient('chan-1', fakeLogger);

    await assert.rejects(
      () => client.fetchPage('chan-1', '2026-01-15T12:00:00.000Z'),
      (err: unknown) => {
        assert.ok(err instanceof RateLimitedError);
        assert.strictEqual(err.retryAfterMs, 30_000);
        return true;
      }
    );
  });

  it('falls back to FlareSolverr on Cloudflare blocks and keeps using it afterwards', async () => {
    let calls = 0;
    fetchTextImpl = async () => {
      calls++;
      throw new Error('Impit request failed with status 403');
    };

    const client = new KickChatWaterfallClient('chan-1', fakeLogger);
    const first = await client.fetchPage('chan-1', '2026-01-15T12:00:00.000Z');
    const second = await client.fetchPage('chan-1', '2026-01-15T12:00:05.000Z');

    // Both calls went through FlareSolverr (second one without retrying impit)
    assert.strictEqual(calls, 1);
    assert.strictEqual(first?.data?.messages?.length, 0);
    assert.strictEqual(second?.data?.messages?.length, 0);
  });

  it('throws when FlareSolverr fails', async () => {
    fetchTextImpl = async () => {
      throw new Error('Impit request failed with status 403');
    };
    flareResult = { success: false, error: 'HTTP 500', code: 'HTTP_ERROR' as const };

    const client = new KickChatWaterfallClient('chan-1', fakeLogger);

    await assert.rejects(() => client.fetchPage('chan-1', '2026-01-15T12:00:00.000Z'), /FlareSolverr failed: HTTP 500/);
  });
});
