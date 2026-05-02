import Fastify, { FastifyInstance } from 'fastify';
import { hasStatusCode, extractErrorDetails } from '../../src/utils/error.js';

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

  server.setErrorHandler((error: unknown, _request, reply) => {
    const statusCode = hasStatusCode(error) ? error.statusCode : 500;
    const { message } = extractErrorDetails(error);
    return reply.status(statusCode).send({
      statusCode,
      message: statusCode >= 500 ? 'Internal server error' : message,
      code: 'INTERNAL_SERVER_ERROR',
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
