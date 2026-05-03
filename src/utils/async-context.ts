import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface TenantContextData {
  displayName?: string;
  tenantId?: string | null;
  reqId?: string;
}

const tenantContextStore = new AsyncLocalStorage<TenantContextData>();

export function getRequestId(): string | undefined {
  return tenantContextStore.getStore()?.reqId;
}

export function getTenantId(): string | null | undefined {
  return tenantContextStore.getStore()?.tenantId;
}

export function getDisplayName(): string | undefined {
  return tenantContextStore.getStore()?.displayName;
}

export function generateRequestId(): string {
  return randomUUID();
}

export function enterTenantContext(context: TenantContextData): void {
  tenantContextStore.enterWith(context);
}

/**
 * Clear the tenant context for the current async chain by entering with an empty store.
 * Used after request completion to prevent context leakage into subsequent async work.
 */
export function exitTenantContext(): void {
  tenantContextStore.enterWith({});
}
