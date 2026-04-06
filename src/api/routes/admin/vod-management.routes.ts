import { FastifyInstance } from 'fastify';
import { extractErrorDetails } from '../../../utils/error.js';
import { getTenantStats, getAllTenants } from '../../../services/tenants.service';
import { getClient } from '../../../db/client.js';
import createRateLimitMiddleware from '../../middleware/rate-limit';
import adminApiKeyMiddleware from '../../middleware/admin-api-key';
import { adminRateLimiter } from '../../plugins/redis.plugin';
import { createAutoLogger } from '../../../utils/auto-tenant-logger.js';
import { serviceUnavailable, badRequest, internalServerError } from '../../../utils/http-error';

interface CreateVodParams {
  id: string;
}
interface DeleteVodParams {
  id: string;
  vodId: number;
}
interface StatsParams {
  id: string;
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
    '/:id/stats',
    {
      schema: {
        tags: ['Admin'],
        description: 'Get detailed stats for a tenant',
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
      const tenantId = request.params.id;
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
    '/:id/vods/create',
    {
      schema: {
        tags: ['Admin'],
        description: 'Create a VOD record manually (without drive field)',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          properties: {
            vodId: { type: 'number' },
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
      const tenantId = request.params.id;
      const body = request.body;
      const log = createAutoLogger(tenantId);

      try {
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
      } catch (error) {
        const details = extractErrorDetails(error);
        const errorMsg = details.message;
        log.error(`VOD creation failed: ${errorMsg}`);

        internalServerError('Failed to create VOD record');
      }
    }
  );

  // Delete a VOD and all related data
  fastify.delete<{ Params: DeleteVodParams }>(
    '/:id/vods/:vodId/delete',
    {
      schema: {
        tags: ['Admin'],
        description: 'Delete a VOD and all related data (chapters, games, uploads)',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, vodId: { type: 'number' } },
          required: ['id', 'vodId'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const tenantId = request.params.id;
      const vodId = request.params.vodId;
      const log = createAutoLogger(tenantId);

      try {
        const client = getClient(tenantId);

        if (!client) serviceUnavailable('Database not available');

        await client.vod.delete({ where: { id: vodId } });

        log.info(`Deleted VOD ${vodId} and all related data (cascade)`);

        return { data: { message: `Deleted VOD ${vodId} and all related data`, vodId } };
      } catch (error) {
        const details = extractErrorDetails(error);
        const errorMsg = details.message;
        log.error(`VOD deletion failed: ${errorMsg}`);

        internalServerError('Failed to delete VOD record');
      }
    }
  );

  return fastify;
}
