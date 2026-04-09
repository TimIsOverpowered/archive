import { FastifyRequest, FastifyReply } from 'fastify';
import { getTenantDisplayName } from '../../config/loader.js';
import { enterTenantContext, exitTenantContext, TenantContextData } from '../../utils/async-context.js';

// Extend request type to include tenant context for type safety
declare module 'fastify' {
  interface FastifyRequest {
    tenantDisplayName?: string;
  }
}

/**
 * Simple middleware that sets tenant context in async-local storage.
 * This enables the pino mixin in server.ts to automatically inject tenant field into structured logs,
 * and allows route handlers to use createAutoLogger() without explicit tenantId parameter.
 */
export default function createTenantLoggerMiddleware() {
  return async function tenantLoggerMiddleware(request: FastifyRequest, _reply: FastifyReply) {
    // Extract tenantId from params (routes like /api/v1/:tenantId/vods/* or /api/v1/admin/:tenantId/...)
    const params = request.params as Record<string, string>;

    let tenantId: string | undefined;

    if ('tenantId' in params) {
      // Routes use 'tenantId' parameter
      tenantId = String(params.tenantId);
    }

    if (!tenantId) return; // No tenant context available for this route (e.g., health check, root paths)

    const displayName = getTenantDisplayName(tenantId);
    request.tenantDisplayName = displayName;

    // Set tenant in async-local storage so pino mixin can read it automatically during handler execution
    const context: TenantContextData = { displayName, tenantId };

    enterTenantContext(context);
  };
}

// Export exit helper for cleanup if needed (Fastify handles this via request lifecycle)
export { getTenantDisplayName, exitTenantContext };
