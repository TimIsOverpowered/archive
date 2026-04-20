export const redisConnectionFailed = new Map<string, boolean>();

export function markConnectionFailed(tenantId: string): void {
  if (!redisConnectionFailed.get(tenantId)) {
    redisConnectionFailed.set(tenantId, true);
  }
}

export function markConnectionRestored(tenantId: string): void {
  if (redisConnectionFailed.get(tenantId)) {
    redisConnectionFailed.set(tenantId, false);
  }
}
