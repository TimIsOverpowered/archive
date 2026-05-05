import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { resetEnvConfig } from '../../src/config/env.js';
import { simpleKeys, swrKeys } from '../../src/utils/cache-keys.js';
import { withCache, withStaleWhileRevalidate, CacheContext } from '../../src/utils/cache.js';

const VALID_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function setupBaseEnv(): void {
  Object.keys(process.env).forEach((key) => delete process.env[key]);
  process.env.REDIS_URL = 'redis://localhost';
  process.env.META_DATABASE_URL = 'postgresql://meta';
  process.env.PGBOUNCER_URL = 'postgresql://bouncer';
  process.env.ENCRYPTION_MASTER_KEY = VALID_KEY;
  process.env.NODE_ENV = 'test';
  process.env.PORT = '3000';
  process.env.LOG_LEVEL = 'info';
  process.env.TWITCH_CLIENT_ID = 'test-twitch-client-id';
  process.env.TWITCH_CLIENT_SECRET = 'test-twitch-client-secret';
  process.env.YOUTUBE_CLIENT_ID = 'test-youtube-client-id';
  process.env.YOUTUBE_CLIENT_SECRET = 'test-youtube-client-secret';
}

describe('withCache', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let ctx: CacheContext;

  beforeEach(() => {
    originalEnv = { ...process.env };
    setupBaseEnv();
    resetEnvConfig();
    ctx = new CacheContext();
  });

  afterEach(() => {
    Object.assign(process.env, originalEnv);
    resetEnvConfig();
  });

  describe('when Redis is unavailable', () => {
    it('should call fetcher and return result without caching', async () => {
      let fetcherCalled = 0;
      const fetcher = async () => {
        fetcherCalled++;
        return { data: 'test', value: fetcherCalled };
      };

      const result1 = await withCache(simpleKeys.stats('test-key'), 60, fetcher, ctx);
      const result2 = await withCache(simpleKeys.stats('test-key'), 60, fetcher, ctx);

      assert.deepStrictEqual(result1, { data: 'test', value: 1 });
      assert.deepStrictEqual(result2, { data: 'test', value: 2 });
      assert.strictEqual(fetcherCalled, 2);
    });

    it('should call fetcher on every request when cache is disabled', async () => {
      let fetcherCalled = 0;
      const fetcher = async () => {
        fetcherCalled++;
        return { count: fetcherCalled };
      };

      for (let i = 0; i < 5; i++) {
        await withCache(simpleKeys.stats('repeat-key'), 60, fetcher, ctx);
      }

      assert.strictEqual(fetcherCalled, 5);
    });

    it('should return different results from repeated fetcher calls', async () => {
      let counter = 0;
      const fetcher = async () => {
        counter++;
        return { callId: counter, value: `call-${counter}` };
      };

      const result1 = await withCache(simpleKeys.stats('counter-key'), 60, fetcher, ctx);
      const result2 = await withCache(simpleKeys.stats('counter-key'), 60, fetcher, ctx);

      assert.strictEqual(result1.callId, 1);
      assert.strictEqual(result2.callId, 2);
      assert.notStrictEqual(result1.value, result2.value);
    });
  });

  describe('error handling', () => {
    it('should return fetcher result when fetcher succeeds', async () => {
      const fetcher = async () => ({ data: 'success' });
      const result = await withCache(simpleKeys.stats('success-key'), 60, fetcher, ctx);

      assert.deepStrictEqual(result, { data: 'success' });
    });

    it('should propagate fetcher errors', async () => {
      const fetcher = async () => {
        throw new Error('Fetcher failed');
      };

      try {
        await withCache(simpleKeys.stats('error-key'), 60, fetcher, ctx);
        assert.fail('Should have thrown');
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.strictEqual(error.message, 'Fetcher failed');
      }
    });
  });

  describe('fetcher behavior', () => {
    it('should pass through fetcher results unchanged', async () => {
      const testCases = ['string value', 42, true, { nested: { object: true } }, [1, 2, 3], null];

      for (const testCase of testCases) {
        const fetcher = async () => testCase;
        const result = await withCache(simpleKeys.stats(`type-test-${JSON.stringify(testCase)}`), 60, fetcher, ctx);
        assert.deepStrictEqual(result, testCase);
      }
    });

    it('should handle empty string result', async () => {
      const fetcher = async () => '';
      const result = await withCache(simpleKeys.stats('empty-key'), 60, fetcher, ctx);
      assert.strictEqual(result, '');
    });

    it('should handle zero result', async () => {
      const fetcher = async () => 0;
      const result = await withCache(simpleKeys.stats('zero-key'), 60, fetcher, ctx);
      assert.strictEqual(result, 0);
    });

    it('should handle false result', async () => {
      const fetcher = async () => false;
      const result = await withCache(simpleKeys.stats('false-key'), 60, fetcher, ctx);
      assert.strictEqual(result, false);
    });

    it('should handle empty object result', async () => {
      const fetcher = async () => ({});
      const result = await withCache(simpleKeys.stats('empty-obj-key'), 60, fetcher, ctx);
      assert.deepStrictEqual(result, {});
    });

    it('should handle empty array result', async () => {
      const fetcher = async () => [];
      const result = await withCache(simpleKeys.stats('empty-arr-key'), 60, fetcher, ctx);
      assert.deepStrictEqual(result, []);
    });
  });
});

describe('withStaleWhileRevalidate', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let ctx: CacheContext;

  beforeEach(() => {
    originalEnv = { ...process.env };
    setupBaseEnv();
    resetEnvConfig();
    ctx = new CacheContext();
  });

  afterEach(() => {
    Object.assign(process.env, originalEnv);
    resetEnvConfig();
  });

  describe('when Redis is unavailable', () => {
    it('should call fetcher and return result without caching', async () => {
      let fetcherCalled = 0;
      const fetcher = async () => {
        fetcherCalled++;
        return { data: 'swr-test', count: fetcherCalled };
      };

      const result = await withStaleWhileRevalidate(swrKeys.stats('swr-key'), 60, 30, fetcher, ctx);
      assert.deepStrictEqual(result, { data: 'swr-test', count: 1 });
      assert.strictEqual(fetcherCalled, 1);
    });

    it('should call fetcher on every request when cache is disabled', async () => {
      let fetcherCalled = 0;
      const fetcher = async () => {
        fetcherCalled++;
        return { count: fetcherCalled };
      };

      for (let i = 0; i < 3; i++) {
        await withStaleWhileRevalidate(swrKeys.stats('swr-repeat-key'), 60, 30, fetcher, ctx);
      }

      assert.strictEqual(fetcherCalled, 3);
    });
  });

  describe('error handling', () => {
    it('should return fetcher result on success', async () => {
      const fetcher = async () => ({ data: 'swr-success' });
      const result = await withStaleWhileRevalidate(swrKeys.stats('swr-success-key'), 60, 30, fetcher, ctx);

      assert.deepStrictEqual(result, { data: 'swr-success' });
    });

    it('should handle fetcher errors gracefully', async () => {
      const fetcher = async () => {
        throw new Error('SWR Fetcher failed');
      };

      try {
        await withStaleWhileRevalidate(swrKeys.stats('swr-fetcher-error'), 60, 30, fetcher, ctx);
        assert.fail('Should have thrown');
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.strictEqual(error.message, 'SWR Fetcher failed');
      }
    });

    it('should propagate error type', async () => {
      class CustomError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'CustomSWRError';
        }
      }

      const fetcher = async () => {
        throw new CustomError('custom swr error');
      };

      try {
        await withStaleWhileRevalidate(swrKeys.stats('swr-custom-error'), 60, 30, fetcher, ctx);
        assert.fail('Should have thrown');
      } catch (error) {
        assert.ok(error instanceof CustomError);
        assert.strictEqual(error.name, 'CustomSWRError');
      }
    });
  });

  describe('fetcher behavior', () => {
    it('should pass through various data types', async () => {
      const testCases = ['string', 123, { key: 'value' }, [1, 2, 3], { nested: { deep: true } }];

      for (const testCase of testCases) {
        const fetcher = async () => testCase;
        const result = await withStaleWhileRevalidate(
          swrKeys.stats(`swr-type-${JSON.stringify(testCase)}`),
          60,
          30,
          fetcher,
          ctx
        );
        assert.deepStrictEqual(result, testCase);
      }
    });

    it('should handle null result', async () => {
      const fetcher = async () => null;
      const result = await withStaleWhileRevalidate(swrKeys.stats('swr-null-key'), 60, 30, fetcher, ctx);
      assert.strictEqual(result, null);
    });

    it('should handle undefined result', async () => {
      const fetcher = async () => undefined;
      const result = await withStaleWhileRevalidate(swrKeys.stats('swr-undefined-key'), 60, 30, fetcher, ctx);
      assert.strictEqual(result, undefined);
    });

    it('should handle complex nested objects', async () => {
      const complexObj = {
        users: [
          { id: 1, name: 'Alice', roles: ['admin', 'user'] },
          { id: 2, name: 'Bob', roles: ['user'] },
        ],
        meta: { total: 2, page: 1 },
        links: { self: '/api/users', next: null },
      };

      const fetcher = async () => complexObj;
      const result = await withStaleWhileRevalidate(swrKeys.stats('swr-complex-key'), 60, 30, fetcher, ctx);
      assert.deepStrictEqual(result, complexObj);
    });
  });
});
