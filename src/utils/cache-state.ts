import { CircuitBreaker } from './circuit-breaker.js';

const CACHE_STATE_KEY = '__cache_connection__';

export const cacheStateBreaker = new CircuitBreaker();

export function isConnectionFailed(tenantId: string): boolean {
  return cacheStateBreaker.isCircuitOpen(`${CACHE_STATE_KEY}:${tenantId}`);
}

export function markConnectionFailed(tenantId: string): void {
  cacheStateBreaker.register(`${CACHE_STATE_KEY}:${tenantId}`, { failureThreshold: 1, recoveryTimeout: 30_000 });
  cacheStateBreaker.recordFailure(`${CACHE_STATE_KEY}:${tenantId}`);
}

export function markConnectionRestored(tenantId: string): void {
  cacheStateBreaker.recordSuccess(`${CACHE_STATE_KEY}:${tenantId}`);
}

export function clearAllConnectionFailures(): void {
  cacheStateBreaker.clearCircuitsMatching(CACHE_STATE_KEY);
}
