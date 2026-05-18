import { FastifyInstance } from 'fastify';
import { Cache } from '../../constants.js';
import { getAllPublicTenants, getPublicTenantById } from '../../services/meta-tenants.service.js';
import { simpleKeys } from '../../utils/cache-keys.js';
import { defaultCacheContext } from '../../utils/cache.js';
import { notFound } from '../../utils/http-error.js';
import createRateLimitMiddleware from '../middleware/rate-limit.js';
import { ok } from '../response.js';

export default function tenantsRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: fastify.publicRateLimiter });

  fastify.get(
    '/tenants',
    {
      schema: {
        tags: ['Public'],
        description: 'List all tenants with public information only',
      },
      onRequest: [rateLimitMiddleware],
    },
    async () => {
      const cacheKey = simpleKeys.tenantList();
      const tenants = await defaultCacheContext.withCache(cacheKey, Cache.TENANT_LIST_TTL, async () => {
        return getAllPublicTenants();
      });

      return ok(tenants);
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
