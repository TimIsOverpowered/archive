import type { FastifyInstance } from 'fastify';
import { getApiConfig } from '../../../config/env.ts';
import { configService } from '../../../config/tenant-config.ts';
import type { InsertableTenants } from '../../../db/meta-types.ts';
import { invalidateTenantListCache } from '../../../services/cache-tags.ts';
import {
  createTenant,
  deleteTenant,
  getAllTenants,
  getTenantById,
  updateTenant,
} from '../../../services/meta-tenants.service.ts';
import { getTenantStats } from '../../../services/tenants.service.ts';
import { defaultCacheContext } from '../../../utils/cache.ts';
import { simpleKeys } from '../../../utils/cache-keys.ts';
import { notFound } from '../../../utils/http-error.ts';
import adminApiKeyMiddleware from '../../middleware/admin-api-key.ts';
import { requireTenant, tenantMiddleware } from '../../middleware/tenant-platform.ts';
import { ok } from '../../response.ts';

async function invalidatePublicTenantCache(tenantId: string): Promise<void> {
  defaultCacheContext.invalidateKey(simpleKeys.tenantDetail(tenantId));
  await invalidateTenantListCache();
}

export default function tenantsRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  fastify.get(
    '/admin/tenants',
    {
      schema: {
        tags: ['Admin'],
        description: 'List all tenants from the metadata database',
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware],
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
      onRequest: [adminApiKeyMiddleware],
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
            profile_image_url: { type: 'string', nullable: true },
            banner_image_url: { type: 'string', nullable: true },
            background_image_url: { type: 'string', nullable: true },
            twitch: { type: 'object', nullable: true },
            youtube: { type: 'object', nullable: true },
            kick: { type: 'object', nullable: true },
            social_media: { type: 'object', nullable: true },
            database_name: { type: 'string', nullable: true },
            settings: { type: 'object' },
            status: { type: 'string', enum: ['active', 'inactive'], nullable: true },
          },
          required: [],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware],
    },
    async (request) => {
      const tenant = await createTenant(request.body);
      await invalidatePublicTenantCache(tenant.id);
      await configService.reloadTenant(tenant.id);
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
            profile_image_url: { type: 'string', nullable: true },
            banner_image_url: { type: 'string', nullable: true },
            background_image_url: { type: 'string', nullable: true },
            twitch: { type: 'object', nullable: true },
            youtube: { type: 'object', nullable: true },
            kick: { type: 'object', nullable: true },
            social_media: { type: 'object', nullable: true },
            database_name: { type: 'string', nullable: true },
            settings: { type: 'object' },
            status: { type: 'string', enum: ['active', 'inactive'], nullable: true },
          },
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware],
    },
    async (request) => {
      const tenant = await updateTenant(request.params.id, request.body);

      if (!tenant) {
        notFound(`Tenant ${request.params.id} not found`);
      }

      await invalidatePublicTenantCache(tenant.id);
      await configService.reloadTenant(tenant.id);
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
      onRequest: [adminApiKeyMiddleware],
    },
    async (request) => {
      await invalidatePublicTenantCache(request.params.id);
      await deleteTenant(request.params.id);
      await configService.reloadTenant(request.params.id, { publish: false });
      configService.publishConfigChanged(request.params.id);
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
      onRequest: [adminApiKeyMiddleware, tenantMiddleware],
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
