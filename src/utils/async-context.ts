import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantContextData {
  displayName?: string;
  tenantId?: string | null;
}

const tenantContextStore = new AsyncLocalStorage<TenantContextData>();

export function enterTenantContext(context: TenantContextData): void {
  tenantContextStore.enterWith(context);
}

export const exitTenantContext = (): void => {
  tenantContextStore.exit(() => {});
};
