import { FastifyRequest, FastifyReply } from 'fastify';
import { configService } from '../../config/tenant-config.js';
import { ensureClient } from '../../db/streamer-client.js';
import { extractErrorDetails } from '../../utils/error.js';
import type { TenantContext } from '../../types/context.js';
import { type Platform } from '../../types/platforms.js';

export interface TenantPlatformContext extends TenantContext {
  platform: Platform;
}

/**
 * Cast TenantContext to TenantPlatformContext after platformValidationMiddleware runs.
 * Throws if platform is not set — platformValidationMiddleware must have run first.
 */
export function asTenantPlatformContext(ctx: TenantContext): TenantPlatformContext {
  if (!ctx.platform) {
    throw new Error('platformValidationMiddleware must run before asTenantPlatformContext');
  }
  return ctx as TenantPlatformContext;
}

/**
 * Generic tenant middleware - validates tenant exists and database is available.
 * Safe for both public and admin routes (no auth checks).
 * Use this for all routes that need tenant validation.
 * Register in onRequest hook.
 */
export async function tenantMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const tenantId = (request.params as { tenantId?: string }).tenantId;

  if (!tenantId) {
    return reply.status(404).send({
      statusCode: 404,
      message: 'Tenant ID not provided',
      code: 'NOT_FOUND',
    });
  }

  const config = configService.get(tenantId);

  if (!config) {
    return reply.status(404).send({
      statusCode: 404,
      message: 'Tenant not found',
      code: 'NOT_FOUND',
    });
  }

  let client;
  try {
    client = await ensureClient(tenantId, config);
  } catch (err) {
    request.log.error(
      { tenantId, error: extractErrorDetails(err) },
      'Failed to initialize database client during request'
    );
    return reply.status(503).send({
      statusCode: 503,
      message: 'Database not available',
      code: 'SERVICE_UNAVAILABLE',
    });
  }

  request.tenant = {
    tenantId,
    config,
    db: client,
  };
}

/**
 * Platform validation middleware - validates platform from request body
 * Must be used after tenantMiddleware (expects request.tenant to exist)
 * Register in preValidation hook
 */
export async function platformValidationMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const requestPlatform = (request.body as { platform?: string }).platform?.toLowerCase() as Platform;

  if (!requestPlatform) {
    return reply.status(400).send({
      statusCode: 400,
      message: 'Platform is required',
      code: 'BAD_REQUEST',
    });
  }

  const config = request.tenant?.config;

  if (!config) {
    return reply.status(500).send({
      statusCode: 500,
      message: 'Tenant context not found',
      code: 'INTERNAL_SERVER_ERROR',
    });
  }

  if (!config[requestPlatform]?.enabled) {
    return reply.status(400).send({
      statusCode: 400,
      message: `${requestPlatform} is not enabled for this tenant`,
      code: 'BAD_REQUEST',
    });
  }

  (request.tenant as TenantPlatformContext).platform = requestPlatform;
}
