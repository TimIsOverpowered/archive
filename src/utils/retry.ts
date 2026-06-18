/** Configuration for exponential backoff retry logic. */
export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  jitter?: boolean;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  getDelayOverride?: (error: unknown, attempt: number) => number | null;
}

/**
 * Execute an async function with exponential backoff retry.
 * Stops early if shouldRetry returns false for the current error.
 * If getDelayOverride returns a number, it replaces the computed delay.
 */
export async function retryWithBackoff<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { attempts, baseDelayMs, maxDelayMs = 30_000, jitter = true, shouldRetry, getDelayOverride } = options;
  if (attempts <= 0) throw new Error('RetryOptions.attempts must be > 0');
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      if (shouldRetry && !shouldRetry(error, attempt)) throw error;

      const override = getDelayOverride?.(error, attempt);
      let delay: number;
      if (override != null && override > 0) {
        delay = override;
      } else {
        delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
        if (jitter) delay = delay * (0.5 + Math.random() * 0.5);
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
