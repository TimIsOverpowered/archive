import { FastifyInstance } from 'fastify';
import { getTenantStats } from '../../../services/tenants.service.js';
import createRateLimitMiddleware from '../../middleware/rate-limit.js';
import adminApiKeyMiddleware from '../../middleware/admin-api-key.js';
import { tenantMiddleware, platformValidationMiddleware, type TenantPlatformContext } from '../../middleware/tenant-platform.js';
import { adminRateLimiter } from '../../plugins/redis.plugin.js';
import { createAutoLogger } from '../../../utils/auto-tenant-logger.js';
import { badRequest, notFound } from '../../../utils/http-error.js';
import { findVodRecord } from './utils/vod-helpers.js';
import { getApiConfig } from '../../../config/env.js';
import { Platform, PLATFORM_VALUES } from '../../../types/platforms.js';

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
  platform: Platform;
}
interface CreateVodBody {
  vodId: string;
  title?: string;
  createdAt?: string;
  duration?: number;
  platform: Platform;
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
      const { tenantId, db } = request.tenant!;

      const stats = await getTenantStats(db, tenantId, getApiConfig().STATS_CACHE_TTL);
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
            platform: { type: 'string', enum: PLATFORM_VALUES },
          },
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware, tenantMiddleware],
      preValidation: [platformValidationMiddleware],
    },
    async (request) => {
      const { tenantId, db, platform } = request.tenant as TenantPlatformContext;
      const { vodId, title, createdAt, duration } = request.body;
      const log = createAutoLogger(tenantId);

      // Validate vodId is provided
      if (!vodId) {
        badRequest('vodId is required');
      }

      const vodRecord = await findVodRecord(db, vodId, platform);

      if (vodRecord) {
        return { data: { message: `${vodId} already exists!`, vodId: vodId } };
      }

      const newVod = await db.vod.create({
        data: {
          vod_id: vodId,
          title: title || null,
          created_at: createdAt ? new Date(createdAt) : new Date(),
          duration: Number(duration) || 0,
          platform: platform,
        },
      });

      log.info(`Created VOD ${vodId}`);

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
            platform: { type: 'string', enum: PLATFORM_VALUES, description: 'Source platform' },
          },
          required: ['vodId', 'platform'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware, tenantMiddleware],
      preValidation: [platformValidationMiddleware],
    },
    async (request) => {
      const { tenantId, db, platform } = request.tenant as TenantPlatformContext;
      const { vodId } = request.body;
      const log = createAutoLogger(tenantId);

      const vodRecord = findVodRecord(db, vodId, platform);

      if (!vodRecord) notFound(`VOD ${vodId} not found`);

      await db.vod.delete({ where: { platform_vod_id: { vod_id: vodId, platform } } });

      log.info(`Deleted VOD ${vodId} (${platform}) and all related data (cascade)`);

      return { data: { message: `Deleted VOD ${vodId} and all related data`, vodId } };
    }
  );

  return fastify;
}
