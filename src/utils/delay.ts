export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getRetryDelay(retryCount: number, baseDelayMs: number = 60000, maxRetries: number = 6, jitter: boolean = true): number {
  const delay = baseDelayMs * Math.min(retryCount, maxRetries);

  if (jitter) {
    const variation = delay * 0.1;
    return delay - variation + Math.random() * (variation * 2);
  }

  return delay;
}
