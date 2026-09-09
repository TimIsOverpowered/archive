import type { FastifyInstance } from 'fastify';
import { AdminVodUpdateSchema, VodCreateSchema } from '../../../config/schemas.ts';
import { findVodById, findVodByPlatformId } from '../../../db/queries/vods.ts';
import type { SelectableVods, UpdateableVods } from '../../../db/streamer-types.ts';
import { getStrategy } from '../../../services/platforms/index.ts';
import { invalidateAllVodCaches } from '../../../services/cache-invalidator.ts';
import { PLATFORM_VALUES, type Platform } from '../../../types/platforms.ts';
import { createAutoLogger } from '../../../utils/auto-tenant-logger.ts';
import { badRequest, notFound } from '../../../utils/http-error.ts';
import adminApiKeyMiddleware from '../../middleware/admin-api-key.ts';
import {
  asTenantPlatformContext,
  platformValidationMiddleware,
  requireTenant,
  tenantMiddleware,
} from '../../middleware/tenant-platform.ts';
import { ok } from '../../response.ts';
import type {
  CreateVodBody,
  CreateVodParams,
  DeleteVodBody,
  DeleteVodParams,
  UpdateVodBody,
  UpdateVodParams,
} from './types.ts';
import { findOrCreateVodRecord } from './utils/vod-records.ts';

/**
 * Register VOD management routes: stats, create VOD, delete VOD.
 * Requires admin API key authentication and tenant middleware.
 */
export default function vodManagementRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
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
      onRequest: [adminApiKeyMiddleware, tenantMiddleware],
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

        await invalidateAllVodCaches(tenantId, fetchedVod.id, {
          platform: fetchedVod.platform,
          platformVodId: fetchedVod.platform_vod_id ?? undefined,
        });

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

      await invalidateAllVodCaches(tenantId, newVod.id, {
        platform: newVod.platform,
        platformVodId: newVod.platform_vod_id ?? undefined,
      });

      log.info({ vodId }, 'Created VOD');

      return ok({ message: `${newVod.id} created!`, vodId: newVod.id });
    }
  );

  // Update an existing VOD record (identify by numeric dbId OR platform + platform VOD ID)
  fastify.patch<{ Params: UpdateVodParams; Body: UpdateVodBody }>(
    '/vods',
    {
      schema: {
        tags: ['Admin'],
        description: 'Update an existing VOD record (partial update). Invalidate all VOD caches.',
        params: {
          type: 'object',
          properties: { tenantId: { type: 'string', description: 'Tenant ID' } },
          required: ['tenantId'],
        },
        body: {
          type: 'object',
          properties: {
            dbId: { type: 'integer', description: 'Internal numeric VOD ID' },
            platform: { type: 'string', enum: PLATFORM_VALUES, description: 'Source platform (pair with vodId)' },
            vodId: { type: 'string', description: 'Platform VOD ID (pair with platform)' },
            title: { type: 'string', nullable: true, description: 'VOD title' },
            duration: { type: 'number', description: 'Duration in seconds' },
            created_at: { type: 'string', format: 'date-time', description: 'Creation timestamp (ISO)' },
            is_live: { type: 'boolean', description: 'Whether the VOD is live' },
            started_at: {
              type: 'string',
              format: 'date-time',
              nullable: true,
              description: 'Stream start timestamp (ISO)',
            },
            platform_vod_id: { type: 'string', nullable: true, description: 'External platform VOD ID' },
            platform_stream_id: { type: 'string', nullable: true, description: 'External platform stream/session ID' },
          },
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, tenantMiddleware],
    },
    async (request) => {
      const tenantCtx = requireTenant(request);
      const { tenantId, db, config } = tenantCtx;
      const body = request.body;
      const log = createAutoLogger(tenantId);

      const hasDbId = typeof body.dbId === 'number' && Number.isInteger(body.dbId) && body.dbId > 0;
      const hasPlatformId = body.platform != null && body.vodId != null && body.vodId !== '';

      if (hasDbId === hasPlatformId) {
        badRequest('Provide exactly one of "dbId" or ("platform" + "vodId")');
      }

      const target = hasDbId
        ? await findVodById(db, body.dbId as number)
        : await findVodByPlatformId(db, body.vodId as string, body.platform as Platform);

      if (!target) notFound('VOD not found');

      const previousPlatform = target.platform;
      const previousPlatformVodId = target.platform_vod_id;

      if (body.platform != null && config[body.platform]?.enabled !== true) {
        badRequest(`${body.platform} is not enabled for this tenant`);
      }

      const parsed = AdminVodUpdateSchema.parse({
        title: body.title,
        duration: body.duration,
        created_at: body.created_at !== '' ? body.created_at : undefined,
        is_live: body.is_live,
        started_at: body.started_at !== '' ? body.started_at : undefined,
        platform: body.platform,
        platform_vod_id: body.platform_vod_id,
        platform_stream_id: body.platform_stream_id,
      });

      const patch: Record<string, unknown> = {};
      if (parsed.title !== undefined) patch.title = parsed.title;
      if (parsed.duration !== undefined) patch.duration = parsed.duration;
      if (parsed.created_at !== undefined) patch.created_at = parsed.created_at;
      if (parsed.is_live !== undefined) patch.is_live = parsed.is_live;
      if (parsed.started_at !== undefined) patch.started_at = parsed.started_at;
      if (parsed.platform !== undefined) patch.platform = parsed.platform;
      if (parsed.platform_vod_id !== undefined) patch.platform_vod_id = parsed.platform_vod_id;
      if (parsed.platform_stream_id !== undefined) patch.platform_stream_id = parsed.platform_stream_id;

      if (Object.keys(patch).length === 0) {
        badRequest('No fields to update');
      }
      patch.updated_at = new Date();

      const updated = (await db
        .updateTable('vods')
        .set(patch as unknown as UpdateableVods)
        .where('id', '=', target.id)
        .returning([
          'id',
          'platform_vod_id',
          'platform_stream_id',
          'platform',
          'title',
          'duration',
          'created_at',
          'updated_at',
          'is_live',
          'started_at',
        ])
        .executeTakeFirst()) as SelectableVods;

      await invalidateAllVodCaches(tenantId, target.id, {
        platform: updated.platform,
        platformVodId: updated.platform_vod_id ?? undefined,
        previousPlatform: previousPlatform,
        previousPlatformVodId: previousPlatformVodId ?? undefined,
      });

      log.info({ dbId: target.id, fields: Object.keys(patch) }, 'Updated VOD');

      return ok(updated);
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
      onRequest: [adminApiKeyMiddleware, tenantMiddleware],
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

      await invalidateAllVodCaches(tenantId, vodRecord.id, {
        platform: vodRecord.platform,
        platformVodId: vodRecord.platform_vod_id ?? undefined,
      });

      log.info({ vodId, platform }, 'Deleted VOD and all related data (cascade)');

      return ok({ message: `Deleted VOD ${vodId} and all related data`, vodId });
    }
  );

  return fastify;
}
