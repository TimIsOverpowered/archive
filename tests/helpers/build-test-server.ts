import Fastify, { FastifyInstance } from 'fastify';
import { errorResponse } from '../../src/api/response.js';
import { formatErrorResponse } from '../../src/utils/error.js';

export interface TestServer {
  server: FastifyInstance;
  close: () => Promise<void>;
}

export async function buildTestServer(): Promise<TestServer> {
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
    const { statusCode, message, code, isClientError } = formatErrorResponse(error);
    return reply
      .status(statusCode)
      .send(errorResponse(statusCode, isClientError ? message : 'Internal server error', code));
  });

  return {
    server,
    close: async () => {
      await server.close();
    },
  };
}

export async function withTestServer<T>(callback: (server: FastifyInstance) => Promise<T>): Promise<T> {
  const { server } = await buildTestServer();
  try {
    return await callback(server);
  } finally {
    await server.close();
  }
}
