import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import compress from '@fastify/compress';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import redisPlugin from './plugins/redis.plugin.js';
import configPlugin from './plugins/config.plugin.js';
import createTenantLoggerMiddleware, { exitTenantContext } from './middleware/tenant-logger.js';
import { getApiConfig } from '../config/env.js';
import { extractErrorDetails } from '../utils/error.js';
import { HttpError } from '../utils/http-error.js';
import { getLogger } from '../utils/logger.js';
import healthRoutes from './routes/health.js';
import vodsRoutes from './routes/vods.js';
import logsRoutes from './routes/logs.js';
import badgesRoutes from './routes/badges.js';
import { globalAdminRoutes, default as adminRoutes } from './routes/admin/index.js';
import { registerCacheSubscriber } from '../services/cache-invalidator.js';
import { BODY_LIMIT, COMPRESSION_THRESHOLD } from '../constants.js';
import { randomUUID } from 'node:crypto';

interface FormattedError {
  statusCode: number;
  message: string;
  code: string;
  isClientError: boolean;
}

function hasStatusCode(e: unknown): e is { statusCode: number } {
  return (
    typeof e === 'object' &&
    e !== null &&
    'statusCode' in e &&
    typeof (e as { statusCode: unknown }).statusCode === 'number'
  );
}

function formatErrorResponse(error: unknown): FormattedError {
  if (error instanceof HttpError) {
    const { statusCode, message, code } = error;
    return { statusCode, message, code, isClientError: statusCode >= 400 && statusCode < 500 };
  }

  const details = extractErrorDetails(error);
  const statusCode = hasStatusCode(error) ? error.statusCode : 500;
  return {
    statusCode,
    message: details.message,
    code: 'INTERNAL_SERVER_ERROR',
    isClientError: statusCode >= 400 && statusCode < 500,
  };
}

export async function buildServer() {
  const config = getApiConfig();

  const fastify = Fastify({
    bodyLimit: BODY_LIMIT,
    exposeHeadRoutes: true,
    logger: {
      level: config.LOG_LEVEL,
      redact: ['headers.authorization', 'headers.cookie'],
      ...(config.NODE_ENV !== 'production'
        ? {
            transport: {
              target: 'pino-pretty',
              options: { translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' },
            },
          }
        : {}),
    },
    trustProxy: true,
    routerOptions: {
      ignoreTrailingSlash: true,
    },
  });

  // Set error handler immediately after creating instance (before any plugins/routes)
  // This ensures it's properly inherited by all child instances
  fastify.setErrorHandler((error, _request, reply) => {
    const { statusCode, message, code, isClientError } = formatErrorResponse(error);

    if (statusCode >= 500) {
      getLogger().error({ err: error }, 'Request error');
    }

    return reply.status(statusCode).send({
      statusCode,
      message: isClientError ? message : 'Internal server error',
      code,
    });
  });

  // Set 404 handler immediately after error handler
  fastify.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send({
      statusCode: 404,
      message: 'Route not found',
      code: 'NOT_FOUND',
    });
  });

  // Add tenant display name to logger for routes with streamer ID
  const tenantLoggerMiddleware = createTenantLoggerMiddleware();
  fastify.addHook('preHandler', tenantLoggerMiddleware);
  fastify.addHook('onResponse', async () => {
    exitTenantContext();
  });

  // Request ID propagation
  fastify.addHook('preHandler', (request, reply, done) => {
    const requestId = (request.headers['x-request-id'] as string | undefined) ?? randomUUID();
    reply.header('X-Request-ID', requestId);
    done();
  });

  // Security headers
  await fastify.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
  });

  // Compression for large responses (>10KB)
  await fastify.register(compress, {
    threshold: COMPRESSION_THRESHOLD,
  });

  // Load streamer configs and initialize database clients
  await fastify.register(configPlugin);

  // Redis connection + rate limiters
  await fastify.register(redisPlugin, {
    url: getApiConfig().REDIS_URL,
  });

  // Pub/Sub subscriber for cache invalidation events from workers
  registerCacheSubscriber(fastify);

  // Swagger/OpenAPI documentation
  await fastify.register(swagger, {
    openapi: {
      info: {
        title: 'Archive API',
        description: 'VOD and Chat Management API for Streamers',
        version: '1.0.0',
      },
      servers: [{ url: 'https://archive.overpowered.tv/api/v1' }],
      components: {
        securitySchemes: {
          apiKey: {
            type: 'apiKey',
            in: 'header',
            name: 'X-API-Key',
            description: 'API key (starts with "archive_"). Also accepts Authorization header as Bearer token.',
          },
        },
      },
      security: [],
    },
  });

  await fastify.register(swaggerUI, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: false,
    },
  });

  // Global CORS with route-based origin checking
  await fastify.register(cors, {
    origin: true,
    credentials: true,
    exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'X-Request-ID'],
  });

  // Register public routes
  await fastify.register(async (instance) => {
    await instance.register(healthRoutes, { prefix: '/api/v1' });

    // Register VODs and logs under same prefix to avoid duplicate OPTIONS handlers
    await instance.register(
      async (vodInstance) => {
        await vodInstance.register(vodsRoutes, { prefix: '' });
        await vodInstance.register(logsRoutes, { prefix: '' });
      },
      { prefix: '/api/v1/' }
    );

    // Register badges route under /api/v1/:id/badges/twitch
    await instance.register(badgesRoutes, { prefix: '/api/v1' });
  });

  // Register global admin routes (no tenantId required)
  await fastify.register(async (instance) => {
    await instance.register(globalAdminRoutes, { prefix: '/api/v1/admin' });
  });

  // Register tenant-scoped admin routes
  await fastify.register(async (instance) => {
    await instance.register(adminRoutes, { prefix: '/api/v1/:tenantId/admin' });
  });

  return fastify;
}

export default buildServer;
