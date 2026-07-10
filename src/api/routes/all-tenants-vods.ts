import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getCachedRecentVods } from '../../services/all-tenants-vods.service.js';
import { PLATFORM_VALUES, type Platform } from '../../types/platforms.js';
import createRateLimitMiddleware from '../middleware/rate-limit.js';
import { ok } from '../response.js';

export default function allTenantsVodsRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: fastify.publicRateLimiter });

  fastify.get(
    '/vods/recent',
    {
      schema: {
        tags: ['Public'],
        description: 'Get the most recent VODs across all tenants, sorted by creation date',
        query: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'Number of VODs to return' },
            maxTenants: {
              type: 'integer',
              minimum: 1,
              maximum: 200,
              default: 50,
              description: 'Maximum number of tenants to query',
            },
            platform: { type: 'string', enum: PLATFORM_VALUES, description: 'Filter by platform' },
          },
        },
      },
      onRequest: [rateLimitMiddleware],
    },
    async (request) => {
      const query = z
        .object({
          limit: z.coerce.number().int().min(1).max(50).default(10),
          maxTenants: z.coerce.number().int().min(1).max(200).default(50),
          platform: z.enum(PLATFORM_VALUES as [string, ...string[]]).optional(),
        })
        .parse(request.query);

      const platform = query.platform as Platform | undefined;
      const vods = await getCachedRecentVods({ limit: query.limit, maxTenants: query.maxTenants, platform, signal: request.signal });

      return ok(vods);
    }
  );

  return fastify;
}
