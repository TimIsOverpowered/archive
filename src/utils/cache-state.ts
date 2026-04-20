const _state = new Map<string, boolean>();

export function isConnectionFailed(tenantId: string): boolean {
  return _state.get(tenantId) ?? false;
}

export function markConnectionFailed(tenantId: string): void {
  if (!isConnectionFailed(tenantId)) {
    _state.set(tenantId, true);
  }
}

export function markConnectionRestored(tenantId: string): void {
  if (isConnectionFailed(tenantId)) {
    _state.set(tenantId, false);
  }
}
