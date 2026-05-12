import { FastifyInstance } from 'fastify';
import type { InsertableTenants } from '../../../db/meta-types.js';
import {
  createTenant,
  getTenantById,
  getAllTenants,
  updateTenant,
  deleteTenant,
} from '../../../services/meta-tenants.service.js';
import { notFound } from '../../../utils/http-error.js';
import type { AdminContext } from '../../middleware/admin-api-key.js';
import adminApiKeyMiddleware from '../../middleware/admin-api-key.js';
import createRateLimitMiddleware from '../../middleware/rate-limit.js';
import { ok } from '../../response.js';

export default function tenantsRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
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

  fastify.get(
    '/tenants',
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
    '/tenants/:id',
    {
      schema: {
        tags: ['Admin'],
        description: 'Get a tenant by ID',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
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
    '/tenants',
    {
      schema: {
        tags: ['Admin'],
        description: 'Create a new tenant',
        body: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
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
      return ok(tenant);
    }
  );

  fastify.put<{ Params: { id: string }; Body: Partial<InsertableTenants> }>(
    '/tenants/:id',
    {
      schema: {
        tags: ['Admin'],
        description: 'Update a tenant',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
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

      return ok(tenant);
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/tenants/:id',
    {
      schema: {
        tags: ['Admin'],
        description: 'Delete a tenant',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      await deleteTenant(request.params.id);
      return ok({ message: `Tenant ${request.params.id} deleted` });
    }
  );

  return fastify;
}
