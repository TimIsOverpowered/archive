import { FastifyInstance } from 'fastify';
import { getApiConfig } from '../../../config/env.js';
import { VodCreateSchema } from '../../../config/schemas.js';
import { findVodByPlatformId } from '../../../db/queries/vods.js';
import type { SelectableVods } from '../../../db/streamer-types.js';
import { invalidateVodVolatileCache } from '../../../services/cache-tags.js';
import { getStrategy } from '../../../services/platforms/index.js';
import { getTenantStats } from '../../../services/tenants.service.js';
import { invalidateVodStaticCache } from '../../../services/vod-cache.js';
import { PLATFORM_VALUES } from '../../../types/platforms.js';
import { createAutoLogger } from '../../../utils/auto-tenant-logger.js';
import { notFound, badRequest } from '../../../utils/http-error.js';
import adminApiKeyMiddleware from '../../middleware/admin-api-key.js';
import createRateLimitMiddleware from '../../middleware/rate-limit.js';
import {
  tenantMiddleware,
  platformValidationMiddleware,
  asTenantPlatformContext,
  requireTenant,
} from '../../middleware/tenant-platform.js';
import { ok } from '../../response.js';
import type { StatsParams, CreateVodParams, DeleteVodParams, CreateVodBody, DeleteVodBody } from './types.js';
import { findOrCreateVodRecord } from './utils/vod-records.js';

/**
 * Register VOD management routes: stats, create VOD, delete VOD.
 * Requires admin API key authentication, tenant middleware, and rate limiting.
 */
export default function vodManagementRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: fastify.adminRateLimiter });

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
      const controller = new AbortController();
      request.raw.once('close', () => {
        controller.abort();
      });

      const tenantCtx = requireTenant(request);
      const { tenantId, db } = tenantCtx;

      const stats = await getTenantStats(db, tenantId, getApiConfig().STATS_CACHE_TTL, { signal: controller.signal });
      return ok(stats);
    }
  );

  // Create a VOD record manually
  fastify.post<{ Params: CreateVodParams; Body: CreateVodBody }>(
    '/vods/create',
    {
      schema: {
        tags: ['Admin'],
        description: 'Create a VOD record (manual or via platform API)',
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
            source: { type: 'string', enum: ['manual', 'api'], default: 'api' },
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
      const { vodId, source } = request.body;
      const log = createAutoLogger(tenantId);

      if (vodId === '') {
        badRequest('vodId is required');
      }

      const vodRecord = await findVodByPlatformId(db, vodId, platform);

      if (vodRecord) {
        return ok({ message: `${vodId} already exists!`, vodId: vodId });
      }

      if (source === 'api') {
        const fetchedVod = await findOrCreateVodRecord(tenantCtx, vodId, log);

        if (!fetchedVod) {
          notFound(`VOD ${vodId} not found on ${platform}`);
        }

        await invalidateVodStaticCache(tenantId, fetchedVod.id);
        await invalidateVodVolatileCache(tenantId, fetchedVod.id);

        log.info({ vodId }, 'Created/fetched VOD via API');
        return ok({ message: `${fetchedVod.id} created!`, vodId: fetchedVod.id });
      }

      const { title, createdAt, duration } = request.body;

      const strategy = getStrategy(platform);
      const validatedData = VodCreateSchema.parse({
        platformVodId: vodId,
        title: title ?? null,
        created_at: createdAt != null && createdAt !== '' ? new Date(createdAt) : new Date(),
        duration: Number(duration) ?? 0,
        platform,
      });
      const newVod = (await db
        .insertInto('vods')
        .values(
          strategy
            ? strategy.createVodData({
                id: validatedData.platformVodId ?? '',
                title: validatedData.title ?? '',
                createdAt: validatedData.created_at.toISOString(),
                duration: validatedData.duration,
              })
            : {
                platform_vod_id: validatedData.platformVodId ?? null,
                title: validatedData.title,
                created_at: validatedData.created_at.toISOString(),
                duration: validatedData.duration,
                platform: validatedData.platform,
                platform_stream_id: null,
                is_live: false,
              }
        )
        .returning(['id', 'platform_vod_id', 'platform_stream_id', 'platform', 'title', 'duration', 'created_at'])
        .executeTakeFirst()) as SelectableVods;

      await invalidateVodStaticCache(tenantId, newVod.id);
      await invalidateVodVolatileCache(tenantId, newVod.id);

      log.info({ vodId }, 'Created VOD');

      return ok({ message: `${newVod.id} created!`, vodId: newVod.id });
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

      const vodRecord = await findVodByPlatformId(db, vodId, platform);

      if (!vodRecord) notFound(`VOD ${vodId} not found`);

      await db.deleteFrom('vods').where('platform', '=', platform).where('platform_vod_id', '=', vodId).execute();

      await invalidateVodStaticCache(tenantId, vodRecord.id);
      await invalidateVodVolatileCache(tenantId, vodRecord.id);

      log.info({ vodId, platform }, 'Deleted VOD and all related data (cascade)');

      return ok({ message: `Deleted VOD ${vodId} and all related data`, vodId });
    }
  );

  return fastify;
}
