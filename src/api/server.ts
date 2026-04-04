import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import compress from '@fastify/compress';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import redisPlugin from './plugins/redis.plugin';
import configPlugin from './plugins/config.plugin';
import createTenantLoggerMiddleware from './middleware/tenant-logger';
import { extractErrorDetails } from '../utils/error.js';
import { logger } from '../utils/logger.js';

export async function buildServer() {
  const fastify = Fastify({
    bodyLimit: 25 * 1024 * 1024, // 25MB for large payloads
    exposeHeadRoutes: true,
    logger: false,
    trustProxy: true,
  });

  // Add tenant display name to logger for routes with streamer ID
  const tenantLoggerMiddleware = createTenantLoggerMiddleware();
  fastify.addHook('preHandler', tenantLoggerMiddleware);

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
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  });

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
    const healthRoutes = await import('./routes/health');
    const vodsRoutes = await import('./routes/vods');
    const logsRoutes = await import('./routes/logs');
    const badgesRoutes = await import('./routes/badges');

    await instance.register(healthRoutes.default, { prefix: '/api/v1' });

    // Register VODs and logs under same prefix to avoid duplicate OPTIONS handlers
    await instance.register(
      async (vodInstance) => {
        await vodInstance.register(vodsRoutes.default, { prefix: '' });
        await vodInstance.register(logsRoutes.default, { prefix: '' });
      },
      { prefix: '/api/v1/' }
    );

    // Register badges route under /api/v1/:id/badges/twitch
    await instance.register(badgesRoutes.default, { prefix: '/api/v1' });
  });

  // Register admin routes
  await fastify.register(async (instance) => {
    const adminRoutes = await import('./routes/admin');
    await instance.register(adminRoutes.default, { prefix: '/api/v1/admin' });
  });

  // Error handler
  fastify.setErrorHandler((error, request, reply) => {
    const details = extractErrorDetails(error);
    const statusCode = (error as { statusCode?: number }).statusCode || 500;
    const code = (error as { code?: string }).code || 'INTERNAL_ERROR';

    logger.error({ err: details.message, stack: details.stack }, 'Request error');

    // Show actual error message for 4xx errors, generic message for 5xx errors
    const isClientError = statusCode >= 400 && statusCode < 500;
    const errorMessage = isClientError ? details.message : 'Internal server error';

    return reply.status(statusCode).send({
      error: {
        message: errorMessage,
        code,
        statusCode,
      },
    });
  });

  // 404 handler
  fastify.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      error: {
        message: 'Route not found',
        code: 'NOT_FOUND',
        statusCode: 404,
      },
    });
  });

  return fastify;
}

export default buildServer;
