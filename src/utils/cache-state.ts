import { LRUCache } from 'lru-cache';

const _state = new LRUCache<string, true>({
  max: 5000,
  ttl: 60_000,
  allowStale: false,
});

export function isConnectionFailed(tenantId: string): boolean {
  return _state.has(tenantId);
}

export function markConnectionFailed(tenantId: string): void {
  if (!isConnectionFailed(tenantId)) {
    _state.set(tenantId, true);
  }
}

export function markConnectionRestored(tenantId: string): void {
  _state.delete(tenantId);
}

export function clearAllConnectionFailures(): void {
  _state.clear();
}

export const resetCacheState = clearAllConnectionFailures;
