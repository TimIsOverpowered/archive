import { FastifyRequest, FastifyReply } from 'fastify';
import { configService } from '../../config/tenant-config.js';
import {
  enterTenantContext,
  exitTenantContext,
  TenantContextData,
  generateRequestId,
} from '../../utils/async-context.js';

/**
 * Simple middleware that sets tenant context in async-local storage.
 * This enables the pino mixin to automatically inject tenant and reqId fields into structured logs,
 * and allows route handlers to use createAutoLogger() without explicit tenantId parameter.
 */
export default function createTenantLoggerMiddleware() {
  return function tenantLoggerMiddleware(request: FastifyRequest, reply: FastifyReply, done: () => void) {
    // Extract tenantId from params (routes like /api/v1/:tenantId/vods/* or /api/v1/:tenantId/admin/...)
    const params = request.params as Record<string, string>;

    let tenantId: string | undefined;

    if ('tenantId' in params) {
      // Routes use 'tenantId' parameter
      tenantId = String(params.tenantId);
    }

    if (tenantId == null) {
      done();
      return;
    } // No tenant context available for this route (e.g., health check, root paths)

    const config = configService.getSync(tenantId);
    const displayName = config?.displayName ?? tenantId;
    request.tenantDisplayName = displayName;

    // Generate or reuse request ID for tracing across API → workers → DB
    const reqId = generateRequestId();
    request.reqId = reqId;
    reply.header('X-Request-ID', reqId);

    // Set tenant + reqId in async-local storage so pino mixin can read it automatically during handler execution
    const context: TenantContextData = { displayName, tenantId, reqId };

    enterTenantContext(context);

    reply.raw.on('finish', () => {
      exitTenantContext();
    });

    done();
  };
}

// Export exit helper for cleanup if needed (Fastify handles this via request lifecycle)
export { exitTenantContext };
