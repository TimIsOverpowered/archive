import { FastifyInstance } from 'fastify';
import type { AdminContext } from '../../middleware/admin-api-key.js';
import adminApiKeyMiddleware from '../../middleware/admin-api-key.js';
import createRateLimitMiddleware from '../../middleware/rate-limit.js';
import { ok } from '../../response.js';

export default function authRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: fastify.adminRateLimiter });

  fastify.get(
    '/admin/verify',
    {
      schema: {
        tags: ['Admin'],
        description: 'Verify admin API key and return authenticated identity',
        security: [{ apiKey: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  adminId: { type: 'number' },
                  username: { type: 'string' },
                },
              },
            },
          },
        },
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    (request) => {
      const ctx = request.admin as AdminContext;
      return ok({ adminId: ctx.adminId, username: ctx.username });
    }
  );

  return fastify;
}
