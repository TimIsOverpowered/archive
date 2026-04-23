import { isCircuitOpen, recordFailure, recordSuccess, clearCircuit } from './circuit-breaker.js';

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
  clearCircuit(CACHE_STATE_KEY);
}

export const resetCacheState = clearAllConnectionFailures;
