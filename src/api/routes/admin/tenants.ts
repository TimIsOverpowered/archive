import { FastifyInstance } from 'fastify';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { getTenantStats, getAllTenants } from '../../../services/tenants.service.js';
import { getClient } from '../../../db/client.js';
import { getStreamerConfig } from '../../../config/loader.js';
import createRateLimitMiddleware from '../../middleware/rate-limit.js';
import adminApiKeyMiddleware from '../../middleware/admin-api-key.js';

type TenantsRoutesOptions = Record<string, unknown>;

declare module 'fastify' {
  interface FastifyInstance {
    adminRateLimiter: RateLimiterRedis;
  }
}

export default async function tenantsRoutes(fastify: FastifyInstance, _options: TenantsRoutesOptions) {
  const rateLimitMiddleware = createRateLimitMiddleware({
    limiter: fastify.adminRateLimiter,
  });

  fastify.get(
    '/',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'List all tenants (streamers)',
        security: [{ apiKey: [] }],
        headers: {
          type: 'object',
          properties: {
            Authorization: {
              type: 'string',
              description: 'Bearer token with API key (e.g., "Bearer archive_...")',
            },
            'X-API-Key': {
              type: 'string',
              description: 'Direct API key header as alternative to Bearer auth',
            },
          },
        },
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async () => {
      const tenants = await getAllTenants();
      return { data: tenants };
    }
  );

  fastify.get(
    '/:id/stats',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Get detailed stats for a tenant',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Tenant ID' },
          },
          required: ['id'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const { id } = request.params as { id: string };

      const config = getStreamerConfig(id);
      if (!config) {
        throw new Error('Tenant not found');
      }

      const client = getClient(id);
      if (!client) {
        throw new Error('Database not available');
      }

      const stats = await getTenantStats(client, id);
      return { data: stats };
    }
  );

  fastify.post(
    '/:id/vods/:vodId/reupload',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Manually trigger YouTube re-upload for a VOD (stub - Phase 3)',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Tenant ID' },
            vodId: { type: 'string', description: 'VOD ID to re-upload' },
          },
          required: ['id', 'vodId'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const { id, vodId } = request.params as { id: string; vodId: string };

      const config = getStreamerConfig(id);
      if (!config) {
        throw new Error('Tenant not found');
      }

      return {
        data: {
          message: 'Re-upload job queued (stub - Phase 3)',
          jobId: `stub-${id}-${vodId}-${Date.now()}`,
        },
      };
    }
  );
}
