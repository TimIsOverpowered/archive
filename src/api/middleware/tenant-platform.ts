import { FastifyRequest, FastifyReply } from 'fastify';
import { getTenantConfig } from '../../config/loader';
import { getClient } from '../../db/client.js';

type StreamerDbClient = NonNullable<ReturnType<typeof getClient>>;
type TenantConfig = ReturnType<typeof getTenantConfig>;

export interface TenantContext {
  tenantId: string;
  config: TenantConfig;
  client: StreamerDbClient;
  platform?: 'twitch' | 'kick';
}

export interface TenantPlatformContext extends TenantContext {
  platform: 'twitch' | 'kick';
}

declare module 'fastify' {
  interface FastifyRequest {
    tenant: TenantContext;
  }
}

/**
 * Generic tenant middleware - validates tenant exists and database is available
 * Use this for all routes that need tenant validation
 * Register in onRequest hook
 */
export async function tenantMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const tenantId = (request.params as { tenantId?: string }).tenantId;

  if (!tenantId) {
    return reply.status(404).send({
      error: {
        message: 'Tenant ID not provided',
        code: 'NOT_FOUND',
        statusCode: 404,
      },
    });
  }

  const config = getTenantConfig(tenantId);

  if (!config) {
    return reply.status(404).send({
      error: {
        message: 'Tenant not found',
        code: 'NOT_FOUND',
        statusCode: 404,
      },
    });
  }

  const client = getClient(tenantId);

  if (!client) {
    return reply.status(503).send({
      error: {
        message: 'Database not available',
        code: 'SERVICE_UNAVAILABLE',
        statusCode: 503,
      },
    });
  }

  (request as { tenant: TenantContext }).tenant = {
    tenantId,
    config,
    client,
  };
}

/**
 * Platform validation middleware - validates platform from request body
 * Must be used after tenantMiddleware (expects request.tenant to exist)
 * Register in preValidation hook
 */
export async function platformValidationMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const requestPlatform = (request.body as { platform?: string }).platform as 'twitch' | 'kick';

  if (!requestPlatform) {
    return reply.status(400).send({
      error: {
        message: 'Platform is required',
        code: 'BAD_REQUEST',
        statusCode: 400,
      },
    });
  }

  const config = (request.tenant as TenantContext)?.config;

  if (!config) {
    return reply.status(500).send({
      error: {
        message: 'Tenant context not found',
        code: 'INTERNAL_SERVER_ERROR',
        statusCode: 500,
      },
    });
  }

  if (requestPlatform === 'twitch' && !config.twitch?.enabled) {
    return reply.status(400).send({
      error: {
        message: 'Twitch is not enabled for this tenant',
        code: 'BAD_REQUEST',
        statusCode: 400,
      },
    });
  }

  if (requestPlatform === 'kick' && !config.kick?.enabled) {
    return reply.status(400).send({
      error: {
        message: 'Kick is not enabled for this tenant',
        code: 'BAD_REQUEST',
        statusCode: 400,
      },
    });
  }

  (request.tenant as TenantPlatformContext).platform = requestPlatform;
}
