import { FastifyInstance } from 'fastify';
import { getTenantStats } from '../../../services/tenants.service.js';
import createRateLimitMiddleware from '../../middleware/rate-limit.js';
import adminApiKeyMiddleware from '../../middleware/admin-api-key.js';
import {
  tenantMiddleware,
  platformValidationMiddleware,
  asTenantPlatformContext,
  requireTenant,
} from '../../middleware/tenant-platform.js';
import { RedisService } from '../../../utils/redis-service.js';
import { createAutoLogger } from '../../../utils/auto-tenant-logger.js';
import { HttpError } from '../../../utils/http-error.js';
import { findVodRecord } from './utils/vod-helpers.js';
import { getStrategy } from '../../../services/platforms/index.js';
import { getApiConfig } from '../../../config/env.js';
import { VodCreateSchema } from '../../../config/schemas.js';
import { PLATFORM_VALUES } from '../../../types/platforms.js';
import { invalidateVodStaticCache } from '../../../services/vod-cache.js';
import { invalidateVodVolatileCache } from '../../../services/cache-tags.js';
import type { StatsParams, CreateVodParams, DeleteVodParams, CreateVodBody, DeleteVodBody } from './types.js';
import type { InsertableVods, SelectableVods } from '../../../db/streamer-types.js';

/**
 * Register VOD management routes: stats, create VOD, delete VOD.
 * Requires admin API key authentication, tenant middleware, and rate limiting.
 */
export default function vodManagementRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  const adminRateLimiter = RedisService.getLimiter('rate:admin');
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
      const tenantCtx = requireTenant(request);
      const { tenantId, db } = tenantCtx;

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
        params: {
          type: 'object',
          properties: { tenantId: { type: 'string', description: 'Tenant ID' } },
          required: ['tenantId'],
        },
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
      const tenantCtx = asTenantPlatformContext(requireTenant(request));
      const { tenantId, db, platform } = tenantCtx;
      const { vodId, title, createdAt, duration } = request.body;
      const log = createAutoLogger(tenantId);

      // Validate vodId is provided
      if (vodId === '') {
        throw new HttpError(400, 'vodId is required', 'BAD_REQUEST');
      }

      const vodRecord = await findVodRecord(db, vodId, platform);

      if (vodRecord) {
        return { data: { message: `${vodId} already exists!`, vodId: vodId } };
      }

      const strategy = getStrategy(platform);
      const validatedData = VodCreateSchema.parse({
        vod_id: vodId,
        title: title ?? null,
        created_at: createdAt != null && createdAt !== '' ? new Date(createdAt) : new Date(),
        duration: Number(duration) ?? 0,
        platform,
      });
      const newVod = (await db
        .insertInto('vods')
        .values(
          strategy
            ? (strategy.createVodData({
                id: validatedData.vod_id,
                title: validatedData.title ?? '',
                createdAt: validatedData.created_at.toISOString(),
                duration: validatedData.duration,
              }) as InsertableVods)
            : {
                vod_id: validatedData.vod_id,
                title: validatedData.title,
                created_at: validatedData.created_at.toISOString(),
                duration: validatedData.duration,
                platform: validatedData.platform,
                stream_id: null,
                is_live: false,
              }
        )
        .returning(['id', 'vod_id', 'platform', 'title', 'duration', 'stream_id', 'created_at'])
        .executeTakeFirst()) as SelectableVods;

      await invalidateVodStaticCache(tenantId, newVod.id);
      await invalidateVodVolatileCache(tenantId, newVod.id);

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
      const tenantCtx = asTenantPlatformContext(requireTenant(request));
      const { tenantId, db, platform } = tenantCtx;
      const { vodId } = request.body;
      const log = createAutoLogger(tenantId);

      const vodRecord = await findVodRecord(db, vodId, platform);

      if (!vodRecord) throw new HttpError(404, `VOD ${vodId} not found`, 'NOT_FOUND');

      await db.deleteFrom('vods').where('platform', '=', platform).where('vod_id', '=', vodId).execute();

      await invalidateVodStaticCache(tenantId, vodRecord.id);
      await invalidateVodVolatileCache(tenantId, vodRecord.id);

      log.info(`Deleted VOD ${vodId} (${platform}) and all related data (cascade)`);

      return { data: { message: `Deleted VOD ${vodId} and all related data`, vodId } };
    }
  );

  return fastify;
}
