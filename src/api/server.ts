import pino from 'pino';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import compress from '@fastify/compress';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import metrics from 'fastify-metrics';
import redisPlugin from './plugins/redis.plugin';
import createTenantLoggerMiddleware from './middleware/tenant-logger';
import { resolveCurrentDisplayName } from '../utils/async-context.js';
import { extractErrorDetails } from '../utils/error.js';

export async function buildServer() {
  const fastify = Fastify({
    bodyLimit: 25 * 1024 * 1024, // 25MB for large payloads
    exposeHeadRoutes: true,
    loggerInstance: pino({
      level: process.env.LOG_LEVEL || 'info',
      customLevels: { metric: 35 },
      mixin: () => ({
        service: 'archive-api',
        env: process.env.NODE_ENV || 'development',
        tenant: resolveCurrentDisplayName() || undefined, // Auto-inject from async context
      }),
    }) as unknown as pino.Logger,
  });

  // Setup logger with request ID tracking
  fastify.addHook('onRequest', async (request, reply) => {
    const xRequestId = request.headers['x-request-id'];
    const requestId = Array.isArray(xRequestId) ? xRequestId[0] : (xRequestId ?? crypto.randomUUID());
    (request.log as unknown as { reqId: string }).reqId = requestId;
    reply.header('X-Request-ID', requestId);
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

  // Redis connection + rate limiters
  await fastify.register(redisPlugin, {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  });

  // Prometheus metrics (fastify-metrics v12+ API)
  await fastify.register(metrics, {
    endpoint: '/metrics',
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
      { prefix: '/api/v1/vods' }
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
    const errorMessage = details.message;
    const statusCode = (error as { statusCode?: number }).statusCode || 500;
    const code = (error as { code?: string }).code || 'INTERNAL_ERROR';

    request.log.error({ err: errorMessage }, 'Request error');

    return reply.status(statusCode).send({
      error: {
        message: errorMessage || 'Internal server error',
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
