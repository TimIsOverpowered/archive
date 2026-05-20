import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Cache } from '../../constants.js';
import { buildPagination } from '../../db/queries/builders.js';
import { getAllPublicTenantsPaginated, getPublicTenantById } from '../../services/meta-tenants.service.js';
import { simpleKeys } from '../../utils/cache-keys.js';
import { defaultCacheContext } from '../../utils/cache.js';
import { notFound } from '../../utils/http-error.js';
import createRateLimitMiddleware from '../middleware/rate-limit.js';
import { ok, okPaginated } from '../response.js';

export default function tenantsRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: fastify.publicRateLimiter });

  fastify.get(
    '/tenants',
    {
      schema: {
        tags: ['Public'],
        description: 'List all tenants with public information only',
        query: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1, description: 'Page number' },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Items per page' },
            search: {
              type: 'string',
              minLength: 1,
              maxLength: 50,
              description: 'Search tenant ID (case-insensitive partial match)',
            },
          },
        },
      },
      onRequest: [rateLimitMiddleware],
    },
    async (request) => {
      const query = z
        .object({
          page: z.coerce.number().int().min(1).default(1),
          limit: z.coerce.number().int().min(1).max(100).default(20),
          search: z.string().min(1).max(50).optional(),
        })
        .parse(request.query);

      const { page, limit } = buildPagination({ page: query.page, limit: query.limit, maxLimit: 100 });

      const searchCacheKey = simpleKeys.tenantList(page, limit, { search: query.search });
      const result = await defaultCacheContext.withCache(searchCacheKey, Cache.TENANT_LIST_TTL, async () => {
        const opts: { page: number; limit: number; search?: string } = { page, limit };
        if (query.search != null) opts.search = query.search;
        return getAllPublicTenantsPaginated(opts);
      });

      return okPaginated(result.tenants, { page, limit, total: result.total });
    }
  );

  fastify.get<{ Params: { tenantId: string } }>(
    '/tenants/:tenantId',
    {
      schema: {
        tags: ['Public'],
        description: 'Get a single tenant by ID with public information only',
        params: {
          type: 'object',
          properties: { tenantId: { type: 'string', description: 'Tenant ID' } },
          required: ['tenantId'],
        },
      },
      onRequest: [rateLimitMiddleware],
    },
    async (request) => {
      const tenantId = request.params.tenantId.toLowerCase();
      const cacheKey = simpleKeys.tenantDetail(tenantId);

      const tenant = await defaultCacheContext.withCache(cacheKey, Cache.TENANT_LIST_TTL, async () => {
        return getPublicTenantById(tenantId);
      });

      if (!tenant) {
        notFound(`Tenant ${tenantId} not found`);
      }

      return ok(tenant);
    }
  );

  return fastify;
}
