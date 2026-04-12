export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  jitter?: boolean;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

export async function retryWithBackoff<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { attempts, baseDelayMs, maxDelayMs = 30_000, jitter = true, shouldRetry } = options;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      if (shouldRetry && !shouldRetry(error, attempt)) throw error;

      let delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      if (jitter) delay = delay * (0.5 + Math.random() * 0.5);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
