/** Pause execution for the specified milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Apply jitter to a base delay. Returns baseMs ± (range * 100)%. */
export function jitter(baseMs: number, range = 0.4): number {
  const variation = baseMs * range;
  return baseMs - variation + Math.random() * (variation * 2);
}

/**
 * Calculate a retry delay with linear backoff and optional jitter.
 * Used for token refresh retries.
 */
export function getRetryDelay(
  retryCount: number,
  baseDelayMs: number = 60000,
  maxRetries: number = 6,
  jitter: boolean = true
): number {
  const delay = baseDelayMs * Math.min(retryCount, maxRetries);

  if (jitter) {
    const variation = delay * 0.1;
    return delay - variation + Math.random() * (variation * 2);
  }

  return delay;
}
