import Fastify, { FastifyInstance } from 'fastify';
import { RedisService } from '../../src/utils/redis-service.js';
import { MockRedisClient } from './mock-redis.js';
import { resetEnvConfig } from '../../src/config/env.js';

export interface TestServerOptions {
  disableRedis?: boolean;
}

export interface TestServer {
  server: FastifyInstance;
  close: () => Promise<void>;
}

export async function buildTestServer(_options: TestServerOptions = {}): Promise<TestServer> {
  const server = Fastify({
    bodyLimit: 25 * 1024 * 1024,
    exposeHeadRoutes: true,
    logger: false,
    trustProxy: true,
    routerOptions: {
      ignoreTrailingSlash: true,
    },
  });

  server.setErrorHandler((error, _request, reply) => {
    const statusCode = error.statusCode ?? 500;
    return reply.status(statusCode).send({
      error: {
        message: 'Internal server error',
        statusCode,
      },
    });
  });

  return {
    server,
    close: async () => {
      await server.close();
    },
  };
}

export async function withTestServer<T>(
  options: TestServerOptions,
  callback: (server: FastifyInstance) => Promise<T>
): Promise<T> {
  const { server } = await buildTestServer(options);
  try {
    return await callback(server);
  } finally {
    await server.close();
  }
}
