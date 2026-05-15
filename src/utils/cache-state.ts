import { CircuitBreaker } from './circuit-breaker.js';

const CACHE_STATE_KEY = '__cache_connection__';
const cacheKey = (tenantId: string) => `${CACHE_STATE_KEY}:${tenantId}` as const;

export const cacheStateBreaker = new CircuitBreaker();

export function isConnectionFailed(tenantId: string): boolean {
  return cacheStateBreaker.isCircuitOpen(cacheKey(tenantId));
}

export function markConnectionFailed(tenantId: string): void {
  cacheStateBreaker.register(cacheKey(tenantId), { failureThreshold: 1, recoveryTimeout: 30_000 });
  cacheStateBreaker.recordFailure(cacheKey(tenantId));
}

export function markConnectionRestored(tenantId: string): void {
  cacheStateBreaker.recordSuccess(cacheKey(tenantId));
}

export function clearAllConnectionFailures(): void {
  cacheStateBreaker.clearCircuitsMatching(CACHE_STATE_KEY);
}
