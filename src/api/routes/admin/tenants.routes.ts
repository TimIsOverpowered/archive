import { FastifyInstance } from 'fastify';
import { getApiConfig } from '../../../config/env.js';
import type { InsertableTenants } from '../../../db/meta-types.js';
import {
  createTenant,
  getTenantById,
  getAllTenants,
  updateTenant,
  deleteTenant,
} from '../../../services/meta-tenants.service.js';
import { getTenantStats } from '../../../services/tenants.service.js';
import { CacheKeys, simpleKeys } from '../../../utils/cache-keys.js';
import { defaultCacheContext } from '../../../utils/cache.js';
import { notFound } from '../../../utils/http-error.js';
import { RedisService } from '../../../utils/redis-service.js';
import adminApiKeyMiddleware from '../../middleware/admin-api-key.js';
import createRateLimitMiddleware from '../../middleware/rate-limit.js';
import { tenantMiddleware, requireTenant } from '../../middleware/tenant-platform.js';
import { ok } from '../../response.js';

function invalidatePublicTenantCache(tenantId: string): void {
  defaultCacheContext.invalidateKey(simpleKeys.tenantList());
  defaultCacheContext.invalidateKey(simpleKeys.tenantDetail(tenantId));

  const client = RedisService.getActiveClient();
  if (client) {
    void client.unlink(CacheKeys.tenantList(), CacheKeys.tenantDetail(tenantId)).catch(() => {});
  }
}

export default function tenantsRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: fastify.adminRateLimiter });

  fastify.get(
    '/admin/tenants',
    {
      schema: {
        tags: ['Admin'],
        description: 'List all tenants from the metadata database',
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async () => {
      const tenants = await getAllTenants();
      return ok(tenants);
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/admin/tenants/:id',
    {
      schema: {
        tags: ['Admin'],
        description: 'Get a tenant by ID',
        params: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Tenant ID' } },
          required: ['id'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const tenant = await getTenantById(request.params.id);

      if (!tenant) {
        notFound(`Tenant ${request.params.id} not found`);
      }

      return ok(tenant);
    }
  );

  fastify.post<{ Body: InsertableTenants }>(
    '/admin/tenants',
    {
      schema: {
        tags: ['Admin'],
        description: 'Create a new tenant',
        body: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Tenant ID' },
            display_name: { type: 'string', nullable: true },
            twitch: { type: 'object', nullable: true },
            youtube: { type: 'object', nullable: true },
            kick: { type: 'object', nullable: true },
            database_name: { type: 'string', nullable: true },
            settings: { type: 'object' },
          },
          required: [],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const tenant = await createTenant(request.body);
      invalidatePublicTenantCache(tenant.id);
      return ok(tenant);
    }
  );

  fastify.put<{ Params: { id: string }; Body: Partial<InsertableTenants> }>(
    '/admin/tenants/:id',
    {
      schema: {
        tags: ['Admin'],
        description: 'Update a tenant',
        params: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Tenant ID' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            display_name: { type: 'string', nullable: true },
            twitch: { type: 'object', nullable: true },
            youtube: { type: 'object', nullable: true },
            kick: { type: 'object', nullable: true },
            database_name: { type: 'string', nullable: true },
            settings: { type: 'object' },
          },
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const tenant = await updateTenant(request.params.id, request.body);

      if (!tenant) {
        notFound(`Tenant ${request.params.id} not found`);
      }

      invalidatePublicTenantCache(tenant.id);
      return ok(tenant);
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/admin/tenants/:id',
    {
      schema: {
        tags: ['Admin'],
        description: 'Delete a tenant',
        params: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Tenant ID' } },
          required: ['id'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      invalidatePublicTenantCache(request.params.id);
      await deleteTenant(request.params.id);
      return ok({ message: `Tenant ${request.params.id} deleted` });
    }
  );

  fastify.get<{ Params: { tenantId: string } }>(
    '/admin/tenants/:tenantId/stats',
    {
      schema: {
        tags: ['Admin'],
        description: 'Get detailed stats for a tenant',
        params: {
          type: 'object',
          properties: { tenantId: { type: 'string', description: 'Tenant ID' } },
          required: ['tenantId'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware, tenantMiddleware],
    },
    async (request) => {
      const tenantCtx = requireTenant(request);
      const { tenantId, db } = tenantCtx;

      const stats = await getTenantStats(db, tenantId, getApiConfig().STATS_CACHE_TTL);
      return ok(stats);
    }
  );

  return fastify;
}
