import { AsyncLocalStorage } from 'node:async_hooks';
import { getTenantDisplayName } from '../config/loader.js';

export interface TenantContextData {
  displayName?: string;
  streamerId?: string | null;
}

// Singleton async-local storage instance for propagating context across async boundaries
const tenantContextStore = new AsyncLocalStorage<TenantContextData>();

/**
 * Execute a function within the specified tenant context. All async operations
 * spawned during execution will automatically inherit this context until done() is called.
 */
export function runWithTenantContext(context: TenantContextData, executor: () => void): void {
  return tenantContextStore.run(context, () => executor());
}

/**
 * Enter the specified tenant context for middleware/hooks that can't wrap execution with .run().
 */
export function enterTenantContext(context: TenantContextData): void {
  return tenantContextStore.enterWith(context);
}

// Export exit helper so callers can clean up when done (e.g., in Fastify hooks)
export const exitTenantContext = (): void => {
  // In newer Node.js, exit() takes a callback but we just need to revert the store frame
  tenantContextStore.exit(() => {});
};

/**
 * Get current tenant context from async-local storage, or undefined if outside any request scope.
 */
export function getCurrentTenantContext(): TenantContextData | undefined {
  const store = tenantContextStore.getStore();
  return store || undefined;
}

/**
 * Convenience helper to get display name specifically for logging purposes with fallback behavior.
 */
export function resolveCurrentDisplayName(): string | null {
  const context = getCurrentTenantContext();

  if (!context) return null;

  if (context.displayName) return context.displayName;

  if (context.streamerId && context.streamerId !== 'null') {
    const displayName = getTenantDisplayName(String(context.streamerId));
    if (displayName) return displayName || String(context.streamerId);
  }

  return null;
}

// Export singleton for direct access in middleware and other modules that need to set context manually
export { tenantContextStore };
