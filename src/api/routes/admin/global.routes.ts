import { FastifyInstance } from 'fastify';
import { getAllTenants } from '../../../services/tenants.service';
import createRateLimitMiddleware from '../../middleware/rate-limit.js';
import adminApiKeyMiddleware from '../../middleware/admin-api-key.js';
import { RedisService } from '../../../utils/redis-service.js';

/**
 * Register global admin routes: list all tenants.
 * Requires admin API key authentication and rate limiting.
 */
export default async function globalAdminRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  const adminRateLimiter = RedisService.getLimiter('rate:admin');
  if (!adminRateLimiter) {
    throw new Error('Rate limiter not initialized');
  }

  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: adminRateLimiter });

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
    async (_request) => {
      const tenants = await getAllTenants();
      return { data: tenants };
    }
  );

  return fastify;
}
