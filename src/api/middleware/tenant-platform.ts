import { FastifyRequest } from 'fastify';
import { configService } from '../../config/tenant-config.js';
import { ensureClient } from '../../db/streamer-client.js';
import { extractErrorDetails } from '../../utils/error.js';
import type { TenantContext } from '../../types/context.js';
import { isValidPlatform, type Platform } from '../../types/platforms.js';
import { notFound, badRequest, serviceUnavailable, internalServerError } from '../../utils/http-error.js';

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
export async function tenantMiddleware(request: FastifyRequest) {
  const tenantId = (request.params as { tenantId?: string }).tenantId;

  if (tenantId == null) {
    notFound('Tenant ID not provided');
  }

  const config = configService.get(tenantId);

  if (!config) {
    notFound('Tenant not found');
  }

  let client;
  try {
    client = await ensureClient(tenantId, config);
  } catch (err) {
    request.log.error(
      { tenantId, error: extractErrorDetails(err) },
      'Failed to initialize database client during request'
    );
    serviceUnavailable('Database not available');
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
export async function platformValidationMiddleware(request: FastifyRequest) {
  const rawPlatform = (request.body as { platform?: string }).platform;
  if (rawPlatform == null || rawPlatform === '') {
    badRequest('Platform is required');
  }

  const requestPlatform = rawPlatform.toLowerCase();
  if (!isValidPlatform(requestPlatform)) {
    badRequest(`Invalid platform: ${requestPlatform}`);
  }

  const tenant = request.tenant;
  if (tenant == null) {
    internalServerError('Tenant context not found');
  }

  const config = tenant.config;

  if (config[requestPlatform]?.enabled !== true) {
    badRequest(`${requestPlatform} is not enabled for this tenant`);
  }

  (request.tenant as TenantPlatformContext).platform = requestPlatform;
}
