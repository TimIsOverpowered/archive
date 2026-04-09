import { FastifyInstance } from 'fastify';

import { getTenantStats, getAllTenants } from '../../../services/tenants.service';
import { getClient } from '../../../db/client.js';
import createRateLimitMiddleware from '../../middleware/rate-limit';
import adminApiKeyMiddleware from '../../middleware/admin-api-key';
import { adminRateLimiter } from '../../plugins/redis.plugin';
import { createAutoLogger } from '../../../utils/auto-tenant-logger.js';
import { serviceUnavailable, badRequest } from '../../../utils/http-error';

interface CreateVodParams {
  tenantId: string;
}
interface DeleteVodParams {
  tenantId: string;
}
interface DeleteVodBody {
  vodId: string;
  platform: 'twitch' | 'kick';
}
interface StatsParams {
  tenantId: string;
}
interface CreateVodBody {
  vodId?: number;
  title?: string;
  createdAt?: string;
  duration?: number;
  platform?: 'twitch' | 'kick';
}

export default async function vodManagementRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  if (!adminRateLimiter) {
    throw new Error('Rate limiter not initialized');
  }

  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: adminRateLimiter });

  // List all tenants (streamers)
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

  // Get detailed stats for a tenant
  fastify.get<{ Params: StatsParams }>(
    '/:tenantId/stats',
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
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const tenantId = request.params.tenantId;
      const client = getClient(tenantId);

      if (!client) {
        serviceUnavailable('Database not available');
      }

      const stats = await getTenantStats(client, tenantId);
      return { data: stats };
    }
  );

  // Create a VOD record manually
  fastify.post<{ Params: CreateVodParams; Body: CreateVodBody }>(
    '/:tenantId/vods/create',
    {
      schema: {
        tags: ['Admin'],
        description: 'Create a VOD record manually',
        params: { type: 'object', properties: { tenantId: { type: 'string', description: 'Tenant ID' } }, required: ['tenantId'] },
        body: {
          type: 'object',
          properties: {
            vodId: { type: 'string' },
            title: { type: 'string' },
            createdAt: { type: 'string' },
            duration: { type: 'number' },
            platform: { type: 'string', enum: ['twitch', 'kick'] },
          },
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const tenantId = request.params.tenantId;
      const body = request.body;
      const log = createAutoLogger(tenantId);

      const client = getClient(tenantId);

      if (!client) serviceUnavailable('Database not available');

      // Validate vodId is provided
      if (!body.vodId) {
        badRequest('vodId is required');
      }

      const existing = await client.vod.findUnique({ where: { id: body.vodId } });

      if (existing) {
        return { data: { message: `${body.vodId} already exists!`, vodId: body.vodId } };
      }

      const newVod = await client.vod.create({
        data: {
          vod_id: String(body.vodId),
          title: body.title || null,
          created_at: body.createdAt ? new Date(body.createdAt) : undefined,
          duration: Number(body.duration) || 0,
          platform: body.platform || 'twitch',
        },
      });

      log.info(`Created VOD ${body.vodId}`);

      return { data: { message: `${newVod.id} created!`, vodId: newVod.id } };
    }
  );

  // Delete a VOD and all related data
  fastify.delete<{ Params: DeleteVodParams; Body: DeleteVodBody }>(
    '/:tenantId/vods/delete',
    {
      schema: {
        tags: ['Admin'],
        description: 'Delete a VOD and all related data (chapters, games, uploads, logs)',
        params: {
          type: 'object',
          properties: { tenantId: { type: 'string', description: 'Tenant ID' } },
          required: ['tenantId'],
        },
        body: {
          type: 'object',
          properties: {
            vodId: { type: 'string', description: 'Platform VOD ID' },
            platform: { type: 'string', enum: ['twitch', 'kick'], description: 'Source platform' },
          },
          required: ['vodId', 'platform'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const tenantId = request.params.tenantId;
      const { vodId, platform } = request.body;
      const log = createAutoLogger(tenantId);

      const client = getClient(tenantId);

      if (!client) serviceUnavailable('Database not available');

      await client.vod.delete({ where: { platform_vod_id: { vod_id: vodId, platform } } });

      log.info(`Deleted VOD ${vodId} (${platform}) and all related data (cascade)`);

      return { data: { message: `Deleted VOD ${vodId} and all related data`, vodId } };
    }
  );

  return fastify;
}
