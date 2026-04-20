import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { retryWithBackoff } from '../../src/utils/retry';

describe('Retry with Backoff', () => {
  describe('successful operation', () => {
    it('should return result on first attempt', async () => {
      const result = await retryWithBackoff(async () => 'success', { attempts: 3, baseDelayMs: 10 });

      assert.strictEqual(result, 'success');
    });
  });

  describe('retry on failure', () => {
    it('should retry and succeed on second attempt', async () => {
      let attempts = 0;
      const result = await retryWithBackoff(
        async () => {
          attempts++;
          if (attempts === 1) {
            throw new Error('fail');
          }
          return 'success';
        },
        { attempts: 3, baseDelayMs: 1, jitter: false }
      );

      assert.strictEqual(attempts, 2);
      assert.strictEqual(result, 'success');
    });

    it('should retry and succeed on third attempt', async () => {
      let attempts = 0;
      const result = await retryWithBackoff(
        async () => {
          attempts++;
          if (attempts < 3) {
            throw new Error('fail');
          }
          return 'success';
        },
        { attempts: 3, baseDelayMs: 1, jitter: false }
      );

      assert.strictEqual(attempts, 3);
      assert.strictEqual(result, 'success');
    });
  });

  describe('exhaustion', () => {
    it('should throw after max retries exceeded', async () => {
      let attempts = 0;

      try {
        await retryWithBackoff(
          async () => {
            attempts++;
            throw new Error('persistent failure');
          },
          { attempts: 3, baseDelayMs: 1 }
        );
        assert.fail('Should have thrown');
      } catch (error) {
        assert.strictEqual((error as Error).message, 'persistent failure');
        assert.strictEqual(attempts, 3);
      }
    });
  });

  describe('max delay cap', () => {
    it('should respect maxDelayMs cap', async () => {
      let attempts = 0;

      try {
        await retryWithBackoff(
          async () => {
            attempts++;
            throw new Error('fail');
          },
          { attempts: 5, baseDelayMs: 1, maxDelayMs: 2, jitter: false }
        );
      } catch {
        // Expected to fail
      }

      assert.strictEqual(attempts, 5);
    });
  });

  describe('conditional retry', () => {
    it('should skip retry when shouldRetry returns false', async () => {
      let attempts = 0;

      try {
        await retryWithBackoff(
          async () => {
            attempts++;
            throw new Error('non-retryable');
          },
          {
            attempts: 5,
            baseDelayMs: 10,
            shouldRetry: (error) => (error as Error).message !== 'non-retryable',
          }
        );
        assert.fail('Should have thrown');
      } catch (error) {
        assert.strictEqual((error as Error).message, 'non-retryable');
        assert.strictEqual(attempts, 1);
      }
    });

    it('should retry when shouldRetry returns true', async () => {
      let attempts = 0;
      const result = await retryWithBackoff(
        async () => {
          attempts++;
          if (attempts === 1) throw new Error('retryable');
          return 'success';
        },
        {
          attempts: 3,
          baseDelayMs: 1,
          shouldRetry: (error) => (error as Error).message === 'retryable',
        }
      );

      assert.strictEqual(result, 'success');
      assert.strictEqual(attempts, 2);
    });
  });

  describe('error preservation', () => {
    it('should preserve original error message', async () => {
      try {
        await retryWithBackoff(
          async () => {
            throw new Error('original error message');
          },
          { attempts: 2, baseDelayMs: 1 }
        );
        assert.fail('Should have thrown');
      } catch (error) {
        assert.strictEqual((error as Error).message, 'original error message');
      }
    });

    it('should preserve error type', async () => {
      class CustomError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'CustomError';
        }
      }

      try {
        await retryWithBackoff(
          async () => {
            throw new CustomError('custom error');
          },
          { attempts: 1, baseDelayMs: 1 }
        );
        assert.fail('Should have thrown');
      } catch (error) {
        assert.strictEqual((error as CustomError).name, 'CustomError');
      }
    });
  });
});
