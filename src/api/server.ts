import { randomUUID } from 'node:crypto';
import compress from '@fastify/compress';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import Fastify from 'fastify';
import type { FastifyBaseLogger } from 'fastify';
import type { ApiConfig } from '../config/env.js';
import { registerTenantConfigSubscriber } from '../config/tenant-config-subscriber.js';
import { Server } from '../constants.js';
import { registerCacheSubscriber } from '../services/cache-invalidator.js';
import { createErrorContext, formatErrorResponse } from '../utils/error.js';
import { getLogger, createLogger, setGlobalLogger } from '../utils/logger.js';
import createTenantLoggerMiddleware, { exitTenantContext } from './middleware/tenant-logger.js';
import configPlugin from './plugins/config.plugin.js';
import redisPlugin from './plugins/redis.plugin.js';
import { errorResponse } from './response.js';
import { globalAdminRoutes, default as adminRoutes } from './routes/admin/index.js';
import badgesRoutes from './routes/badges.js';
import chaptersRoutes from './routes/chapters.js';
import gamesRoutes from './routes/games.js';
import healthRoutes from './routes/health.js';
import logsRoutes from './routes/logs.js';
import vodsRoutes from './routes/vods.js';

export async function buildServer(config: ApiConfig) {
  const logger = createLogger({ level: config.LOG_LEVEL, isProduction: config.NODE_ENV === 'production' });
  setGlobalLogger(logger);

  const fastify = Fastify({
    bodyLimit: Server.BODY_LIMIT,
    exposeHeadRoutes: true,
    loggerInstance: logger as unknown as FastifyBaseLogger,
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
      getLogger().error(createErrorContext(error), 'Request error');
    }

    return reply
      .status(statusCode)
      .send(errorResponse(statusCode, isClientError ? message : 'Internal server error', code));
  });

  // Set 404 handler immediately after error handler
  fastify.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send(errorResponse(404, 'Route not found', 'NOT_FOUND'));
  });

  // Add tenant display name to logger for routes with streamer ID
  const tenantLoggerMiddleware = createTenantLoggerMiddleware();
  fastify.addHook('preHandler', tenantLoggerMiddleware);
  fastify.addHook('onResponse', (_request, _reply, done) => {
    exitTenantContext();
    done();
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
    threshold: Server.COMPRESSION_THRESHOLD,
  });

  // Load streamer configs and initialize database clients
  await fastify.register(configPlugin);

  // Redis connection + rate limiters
  await fastify.register(redisPlugin, {
    url: config.REDIS_URL,
  });

  // Pub/Sub subscriber for cache invalidation events from workers
  registerCacheSubscriber(fastify);

  // Pub/Sub subscriber for tenant config invalidation events
  registerTenantConfigSubscriber(fastify);

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

    // Register VODs, games, and logs under same prefix to avoid duplicate OPTIONS handlers
    await instance.register(
      async (vodInstance) => {
        await vodInstance.register(vodsRoutes, { prefix: '' });
        await vodInstance.register(gamesRoutes, { prefix: '' });
        await vodInstance.register(chaptersRoutes, { prefix: '' });
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
