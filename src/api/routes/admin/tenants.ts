import { FastifyInstance } from 'fastify';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { getTenantStats, getAllTenants } from '../../../services/tenants.service';
import { getClient } from '../../../db/client';
import { getStreamerConfig } from '../../../config/loader';
import createRateLimitMiddleware from '../../middleware/rate-limit';
import adminJwtMiddleware from '../../middleware/admin-jwt';

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
        security: [{ bearer: [] }],
      },
      onRequest: [adminJwtMiddleware, rateLimitMiddleware],
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
        security: [{ bearer: [] }],
      },
      onRequest: [adminJwtMiddleware, rateLimitMiddleware],
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
        security: [{ bearer: [] }],
      },
      onRequest: [adminJwtMiddleware, rateLimitMiddleware],
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
