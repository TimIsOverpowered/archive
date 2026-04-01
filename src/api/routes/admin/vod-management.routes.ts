import { FastifyInstance } from 'fastify';
import { extractErrorDetails } from '../../../utils/error.js';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { getTenantStats, getAllTenants } from '../../../services/tenants.service';
import { getClient } from '../../../db/client.js';
import createRateLimitMiddleware from '../../middleware/rate-limit';
import adminApiKeyMiddleware from '../../middleware/admin-api-key';

declare module 'fastify' {
  interface FastifyInstance {
    adminRateLimiter: RateLimiterRedis;
  }
}

interface CreateVodParams {
  id: string;
}
interface DeleteVodParams {
  id: string;
  vodId: string;
}
interface StatsParams {
  id: string;
}
interface CreateVodBody {
  vodId?: string;
  title?: string;
  createdAt?: string;
  duration?: number;
  platform?: 'twitch' | 'kick';
}

export default async function vodManagementRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: fastify.adminRateLimiter });

  // List all tenants (streamers)
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
            Authorization: { type: 'string', description: 'Bearer token with API key' },
            'X-API-Key': { type: 'string', description: 'Direct API key header as alternative to Bearer auth' },
          },
        },
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
        tags: ['Admin', 'Tenants'],
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
      const streamerId = request.params.id;
      const client = getClient(streamerId);

      if (!client) {
        throw new Error('Database not available');
      }

      const stats = await getTenantStats(client, streamerId);
      return { data: stats };
    }
  );

  // Create a VOD record manually
  fastify.post<{ Params: CreateVodParams; Body: CreateVodBody }>(
    '/:id/vods/create',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Create a VOD record manually (without drive field)',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
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
      const streamerId = request.params.id;
      const body = request.body;

      try {
        const client = getClient(streamerId);

        if (!client) throw new Error('Database not available');

        // Validate vodId is provided
        if (!body.vodId) {
          throw new Error('vodId is required');
        }

        const existing = await client.vod.findUnique({ where: { id: body.vodId } });

        if (existing) {
          return { data: { message: `${body.vodId} already exists!`, vodId: body.vodId } };
        }

        const newVod = await client.vod.create({
          data: {
            id: body.vodId,
            title: body.title || null,
            created_at: body.createdAt ? new Date(body.createdAt) : undefined,
            duration: Number(body.duration) || 0,
            platform: body.platform || 'twitch',
          },
        });

        request.log.info(`[${streamerId}] Created VOD ${body.vodId}`);

        return { data: { message: `${newVod.id} created!`, vodId: newVod.id } };
      } catch (error) {
        const details = extractErrorDetails(error);
        const errorMsg = details.message;
        request.log.error(`[${streamerId}] VOD creation failed: ${errorMsg}`);

        throw new Error('Failed to create VOD record');
      }
    }
  );

  // Delete a VOD and all related data
  fastify.delete<{ Params: DeleteVodParams }>(
    '/:id/vods/:vodId/delete',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Delete a VOD and all related data (chapters, games, uploads)',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, vodId: { type: 'string' } },
          required: ['id', 'vodId'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const streamerId = request.params.id;
      const vodId = request.params.vodId;

      try {
        const client = getClient(streamerId);

        if (!client) throw new Error('Database not available');

        await client.chatMessage.deleteMany({ where: { vod_id: vodId } });
        await client.vod.deleteMany({ where: { id: vodId } });

        request.log.info(`[${streamerId}] Deleted VOD ${vodId} and related data`);

        return { data: { message: `Deleted VOD ${vodId}`, vodId } };
      } catch (error) {
        const details = extractErrorDetails(error);
        const errorMsg = details.message;
        request.log.error(`[${streamerId}] VOD deletion failed: ${errorMsg}`);

        throw new Error('Failed to delete VOD record');
      }
    }
  );

  return fastify;
}
