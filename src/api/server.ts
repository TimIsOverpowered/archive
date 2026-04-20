import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import compress from '@fastify/compress';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import redisPlugin from './plugins/redis.plugin';
import configPlugin from './plugins/config.plugin';
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

function formatErrorResponse(error: unknown): {
  statusCode: number;
  message: string;
  isClientError: boolean;
} {
  if (error instanceof HttpError) {
    const { statusCode, message } = error;
    return { statusCode, message, isClientError: statusCode >= 400 && statusCode < 500 };
  }

  const details = extractErrorDetails(error);
  const statusCode = (error as { statusCode?: number }).statusCode || 500;
  return {
    statusCode,
    message: details.message,
    isClientError: statusCode >= 400 && statusCode < 500,
  };
}

export async function buildServer() {
  const fastify = Fastify({
    bodyLimit: 25 * 1024 * 1024,
    exposeHeadRoutes: true,
    logger: false,
    trustProxy: true,
    routerOptions: {
      ignoreTrailingSlash: true,
    },
  });

  // Set error handler immediately after creating instance (before any plugins/routes)
  // This ensures it's properly inherited by all child instances
  fastify.setErrorHandler((error, request, reply) => {
    const { statusCode, message, isClientError } = formatErrorResponse(error);

    if (statusCode >= 500) {
      const details = extractErrorDetails(error);
      getLogger().error({ err: details.message, stack: details.stack }, 'Request error');
    }

    return reply.status(statusCode).send({
      error: {
        message: isClientError ? message : 'Internal server error',
        statusCode,
      },
    });
  });

  // Set 404 handler immediately after error handler
  fastify.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      error: {
        message: 'Route not found',
        code: 'NOT_FOUND',
        statusCode: 404,
      },
    });
  });

  // Add tenant display name to logger for routes with streamer ID
  const tenantLoggerMiddleware = createTenantLoggerMiddleware();
  fastify.addHook('preHandler', tenantLoggerMiddleware);
  fastify.addHook('onResponse', async () => {
    exitTenantContext();
  });

  // Security headers
  await fastify.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
  });

  // Compression for large responses (>10KB)
  await fastify.register(compress, {
    threshold: 10240,
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
