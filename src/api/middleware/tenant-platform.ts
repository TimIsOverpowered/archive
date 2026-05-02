import { FastifyRequest, FastifyReply } from 'fastify';
import { configService } from '../../config/tenant-config.js';
import { ensureClient } from '../../db/streamer-client.js';
import { extractErrorDetails } from '../../utils/error.js';
import type { TenantContext } from '../../types/context.js';
import { isValidPlatform, type Platform } from '../../types/platforms.js';

export interface TenantPlatformContext extends TenantContext {
  platform: Platform;
}

function hasPlatform(ctx: TenantContext): ctx is TenantPlatformContext {
  return typeof ctx.platform === 'string' && ctx.platform.length > 0;
}

/**
 * Assert that request.tenant has been set by tenantMiddleware.
 * Throws if tenant is undefined — should only be called in handlers where tenantMiddleware runs.
 */
export function requireTenant(request: FastifyRequest): TenantContext {
  if (!request.tenant) {
    throw new Error('tenantMiddleware must run before this handler');
  }
  return request.tenant;
}

/**
 * Assert TenantContext has been narrowed by platformValidationMiddleware.
 * Throws if platform is not set — platformValidationMiddleware must have run first.
 */
export function asTenantPlatformContext(ctx: TenantContext): TenantPlatformContext {
  if (!hasPlatform(ctx)) {
    throw new Error('platformValidationMiddleware must run before asTenantPlatformContext');
  }
  return ctx;
}

/**
 * Generic tenant middleware - validates tenant exists and database is available.
 * Safe for both public and admin routes (no auth checks).
 * Use this for all routes that need tenant validation.
 * Register in onRequest hook.
 */
export async function tenantMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const tenantId = (request.params as { tenantId?: string }).tenantId;

  if (tenantId == null) {
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
  const rawPlatform = (request.body as { platform?: string }).platform;
  if (rawPlatform == null || rawPlatform === '') {
    return reply.status(400).send({
      statusCode: 400,
      message: 'Platform is required',
      code: 'BAD_REQUEST',
    });
  }

  const requestPlatform = rawPlatform.toLowerCase();
  if (!isValidPlatform(requestPlatform)) {
    return reply.status(400).send({
      statusCode: 400,
      message: `Invalid platform: ${requestPlatform}`,
      code: 'BAD_REQUEST',
    });
  }

  const tenant = request.tenant;
  if (tenant == null) {
    return reply.status(500).send({
      statusCode: 500,
      message: 'Tenant context not found',
      code: 'INTERNAL_SERVER_ERROR',
    });
  }

  const config = tenant.config;

  if (config[requestPlatform]?.enabled !== true) {
    return reply.status(400).send({
      statusCode: 400,
      message: `${requestPlatform} is not enabled for this tenant`,
      code: 'BAD_REQUEST',
    });
  }

  (request.tenant as TenantPlatformContext).platform = requestPlatform;
}
