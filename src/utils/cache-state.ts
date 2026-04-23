import { isCircuitOpen, recordFailure, recordSuccess, breakerCache } from './circuit-breaker.js';

const CACHE_STATE_KEY = '__cache_connection__';

export function isConnectionFailed(tenantId: string): boolean {
  return isCircuitOpen(`${CACHE_STATE_KEY}:${tenantId}`);
}

export function markConnectionFailed(tenantId: string): void {
  recordFailure(`${CACHE_STATE_KEY}:${tenantId}`, { failureThreshold: 1 });
}

export function markConnectionRestored(tenantId: string): void {
  recordSuccess(`${CACHE_STATE_KEY}:${tenantId}`);
}

export function clearAllConnectionFailures(): void {
  for (const key of breakerCache.keys()) {
    if (key.startsWith(CACHE_STATE_KEY)) {
      breakerCache.delete(key);
    }
  }
}
