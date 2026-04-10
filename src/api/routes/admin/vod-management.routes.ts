import { FastifyInstance } from 'fastify';

import { getTenantStats } from '../../../services/tenants.service';
import createRateLimitMiddleware from '../../middleware/rate-limit';
import adminApiKeyMiddleware from '../../middleware/admin-api-key';
import { tenantMiddleware, platformValidationMiddleware, type TenantPlatformContext } from '../../middleware/tenant-platform';
import { adminRateLimiter } from '../../plugins/redis.plugin';
import { createAutoLogger } from '../../../utils/auto-tenant-logger.js';
import { badRequest } from '../../../utils/http-error';

interface StatsParams {
  tenantId: string;
}

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

  // Get detailed stats for a tenant
  fastify.get<{ Params: StatsParams }>(
    '/stats',
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
      const { tenantId, client } = request.tenant!;

      const stats = await getTenantStats(client, tenantId);
      return { data: stats };
    }
  );

  // Create a VOD record manually
  fastify.post<{ Params: CreateVodParams; Body: CreateVodBody }>(
    '/vods/create',
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
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware, tenantMiddleware],
    },
    async (request) => {
      const { tenantId, client } = request.tenant!;
      const body = request.body;
      const log = createAutoLogger(tenantId);

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
    '/vods/delete',
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
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware, tenantMiddleware],
      preValidation: [platformValidationMiddleware],
    },
    async (request) => {
      const { tenantId, client, platform } = request.tenant as TenantPlatformContext;
      const { vodId } = request.body;
      const log = createAutoLogger(tenantId);

      await client.vod.delete({ where: { platform_vod_id: { vod_id: vodId, platform } } });

      log.info(`Deleted VOD ${vodId} (${platform}) and all related data (cascade)`);

      return { data: { message: `Deleted VOD ${vodId} and all related data`, vodId } };
    }
  );

  return fastify;
}
