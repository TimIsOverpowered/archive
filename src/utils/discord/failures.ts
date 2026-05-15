import { LRUCache } from 'lru-cache';

const failureCounts = new LRUCache<string, number>({
  max: 500,
  ttl: 30 * 60 * 1000,
  allowStale: false,
});

export function trackFailure(tenantId: string, maxBeforeAlert: number = 3): boolean {
  const currentCount = (failureCounts.get(tenantId) ?? 0) + 1;
  failureCounts.set(tenantId, currentCount);
  return currentCount >= maxBeforeAlert;
}

export function resetFailures(tenantId: string): void {
  failureCounts.delete(tenantId);
}
