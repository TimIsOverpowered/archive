import { FastifyInstance } from 'fastify';
import { getAllTenants } from '../../../services/tenants.service.js';
import adminApiKeyMiddleware from '../../middleware/admin-api-key.js';
import createRateLimitMiddleware from '../../middleware/rate-limit.js';
import { ok } from '../../response.js';

/**
 * Register global admin routes: list all tenants.
 * Requires admin API key authentication and rate limiting.
 */
export default function globalAdminRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: fastify.adminRateLimiter });

  fastify.get(
    '/tenants',
    {
      schema: {
        tags: ['Admin'],
        description: 'List all tenants (streamers)',
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    (_request) => {
      const tenants = getAllTenants();
      return ok(tenants);
    }
  );

  return fastify;
}
