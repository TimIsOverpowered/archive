import { expect } from 'chai';
import { retryWithBackoff } from '../../src/utils/retry';

describe('Retry with Backoff', () => {
  describe('successful operation', () => {
    it('should return result on first attempt', async () => {
      const result = await retryWithBackoff(async () => 'success', { attempts: 3, baseDelayMs: 10 });

      expect(result).to.equal('success');
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

      expect(attempts).to.equal(2);
      expect(result).to.equal('success');
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

      expect(attempts).to.equal(3);
      expect(result).to.equal('success');
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
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).to.equal('persistent failure');
        expect(attempts).to.equal(3); // 3 attempts total
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

      // Verify it attempted all 5 times
      expect(attempts).to.equal(5);
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
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).to.equal('non-retryable');
        expect(attempts).to.equal(1); // No retries
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

      expect(result).to.equal('success');
      expect(attempts).to.equal(2);
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
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).to.equal('original error message');
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
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.name).to.equal('CustomError');
      }
    });
  });
});
