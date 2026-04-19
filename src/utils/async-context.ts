import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface TenantContextData {
  displayName?: string;
  tenantId?: string | null;
  reqId?: string;
}

const tenantContextStore = new AsyncLocalStorage<TenantContextData>();

let currentStore = tenantContextStore.getStore();

export function getRequestId(): string | undefined {
  return currentStore?.reqId;
}

export function generateRequestId(): string {
  return randomUUID();
}

export function enterTenantContext(context: TenantContextData): void {
  tenantContextStore.enterWith(context);
  currentStore = tenantContextStore.getStore();
}

export const exitTenantContext = (): void => {
  tenantContextStore.exit(() => {});
  currentStore = tenantContextStore.getStore();
};
