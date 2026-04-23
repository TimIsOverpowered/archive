const inflight = new Map<string, Promise<unknown>>();

/**
 * Deduplicate concurrent calls with the same key.
 * Only one instance of the function runs per key; others wait for the result.
 */
export function deduplicate<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (inflight.has(key)) return inflight.get(key) as Promise<T>;

  const promise = fn().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}
