import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import {
  AdminChapterUpdateSchema,
  AdminChapterUpsertSchema,
  AdminGameUpdateSchema,
  AdminGameUpsertSchema,
  AdminVodUploadUpdateSchema,
  AdminVodUploadUpsertSchema,
  EmoteUpsertSchema,
} from '../../../config/schemas.ts';
import type {
  SelectableChapters,
  SelectableGames,
  SelectableVodUploads,
  StreamerDB,
  UpdateableChapters,
  UpdateableGames,
  UpdateableVodUploads,
} from '../../../db/streamer-types.ts';
import { invalidateAllVodCaches } from '../../../services/cache-invalidator.ts';
import { invalidateEmoteCache } from '../../../services/vod-cache.ts';
import { createAutoLogger } from '../../../utils/auto-tenant-logger.ts';
import { badRequest, notFound } from '../../../utils/http-error.ts';
import adminApiKeyMiddleware from '../../middleware/admin-api-key.ts';
import { requireTenant, tenantMiddleware } from '../../middleware/tenant-platform.ts';
import { ok } from '../../response.ts';

type ChapterCreateBody = z.infer<typeof AdminChapterUpsertSchema>;
type ChapterUpdateBody = z.infer<typeof AdminChapterUpdateSchema>;
type GameCreateBody = z.infer<typeof AdminGameUpsertSchema>;
type GameUpdateBody = z.infer<typeof AdminGameUpdateSchema>;
type UploadCreateBody = z.infer<typeof AdminVodUploadUpsertSchema>;
type UploadUpdateBody = z.infer<typeof AdminVodUploadUpdateSchema>;
type EmoteBody = z.infer<typeof EmoteUpsertSchema>;

const IdParamSchema = z.coerce.number().int().min(1);

const TENANT_PARAM = {
  type: 'object',
  properties: { tenantId: { type: 'string', description: 'Tenant ID' } },
  required: ['tenantId'],
} as const;

const ID_PARAM = {
  type: 'object',
  properties: {
    tenantId: { type: 'string', description: 'Tenant ID' },
    id: { type: 'integer', description: 'Row ID' },
  },
  required: ['tenantId', 'id'],
} as const;

/** Confirm the parent VOD exists before inserting a child row (clean 404 over an FK error). */
async function assertVodExists(db: Kysely<StreamerDB>, vodId: number): Promise<void> {
  const vod = await db.selectFrom('vods').select('id').where('id', '=', vodId).executeTakeFirst();
  if (!vod) notFound(`VOD ${vodId} not found`);
}

/**
 * Invalidate every VOD endpoint cache for a VOD, resolving its current
 * platform identity so the detail-by-platform key is cleared too.
 */
async function invalidateVodByDbId(tenantId: string, db: Kysely<StreamerDB>, vodId: number): Promise<void> {
  const identity = await db
    .selectFrom('vods')
    .select(['platform', 'platform_vod_id'])
    .where('id', '=', vodId)
    .executeTakeFirst();

  await invalidateAllVodCaches(tenantId, vodId, {
    platform: identity?.platform,
    platformVodId: identity?.platform_vod_id ?? undefined,
  });
}

/**
 * Register tenant-scoped admin content-management routes for the VOD child
 * tables: chapters, games, vod_uploads and emotes. Supports create / update /
 * delete. Every mutation invalidates the VOD endpoint caches so end users see
 * the change immediately.
 */
export default function contentManagementRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  // ── Chapters ────────────────────────────────────────────────────────────────
  fastify.post<{ Params: { tenantId: string }; Body: ChapterCreateBody }>(
    '/chapters',
    {
      schema: {
        tags: ['Admin'],
        description: 'Create a chapter for a VOD',
        params: TENANT_PARAM,
        body: {
          type: 'object',
          properties: {
            vod_id: { type: 'integer' },
            game_id: { type: 'string', nullable: true },
            name: { type: 'string', nullable: true },
            image: { type: 'string', nullable: true },
            start: { type: 'number' },
            duration: { type: 'number' },
            end: { type: 'number', nullable: true },
          },
          required: ['vod_id', 'start'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, tenantMiddleware],
    },
    async (request) => {
      const { tenantId, db } = requireTenant(request);
      const parsed = AdminChapterUpsertSchema.parse(request.body);
      await assertVodExists(db, parsed.vod_id);

      const created = (await db
        .insertInto('chapters')
        .values({
          vod_id: parsed.vod_id,
          game_id: parsed.game_id,
          name: parsed.name,
          image: parsed.image,
          start: parsed.start,
          duration: parsed.duration,
          end: parsed.end,
        })
        .returning(['id', 'vod_id', 'game_id', 'name', 'image', 'start', 'duration', 'end'])
        .executeTakeFirst()) as SelectableChapters;

      await invalidateVodByDbId(tenantId, db, created.vod_id);
      return ok(created);
    }
  );

  fastify.patch<{ Params: { tenantId: string; id: string }; Body: ChapterUpdateBody }>(
    '/chapters/:id',
    {
      schema: {
        tags: ['Admin'],
        description: 'Update a chapter',
        params: ID_PARAM,
        body: {
          type: 'object',
          properties: {
            game_id: { type: 'string', nullable: true },
            name: { type: 'string', nullable: true },
            image: { type: 'string', nullable: true },
            start: { type: 'number' },
            duration: { type: 'number' },
            end: { type: 'number', nullable: true },
          },
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, tenantMiddleware],
    },
    async (request) => {
      const idParse = IdParamSchema.safeParse(request.params.id);
      if (!idParse.success) badRequest('Invalid chapter id');
      const rowId = idParse.data;

      const { tenantId, db } = requireTenant(request);
      const log = createAutoLogger(tenantId);

      const row = await db.selectFrom('chapters').select(['id', 'vod_id']).where('id', '=', rowId).executeTakeFirst();
      if (!row) notFound(`Chapter ${rowId} not found`);

      const parsed = AdminChapterUpdateSchema.parse(request.body);
      const patch: UpdateableChapters = {};
      if (parsed.name !== undefined) patch.name = parsed.name;
      if (parsed.image !== undefined) patch.image = parsed.image;
      if (parsed.start !== undefined) patch.start = parsed.start;
      if (parsed.duration !== undefined) patch.duration = parsed.duration;
      if (parsed.end !== undefined) patch.end = parsed.end;
      if (parsed.game_id !== undefined) patch.game_id = parsed.game_id;

      if (Object.keys(patch).length === 0) badRequest('No fields to update');

      const updated = (await db
        .updateTable('chapters')
        .set(patch)
        .where('id', '=', rowId)
        .returning(['id', 'vod_id', 'game_id', 'name', 'image', 'start', 'duration', 'end'])
        .executeTakeFirst()) as SelectableChapters;

      await invalidateVodByDbId(tenantId, db, row.vod_id);
      log.info({ chapterId: rowId, vodId: row.vod_id }, 'Updated chapter');
      return ok(updated);
    }
  );

  fastify.delete<{ Params: { tenantId: string; id: string } }>(
    '/chapters/:id',
    {
      schema: {
        tags: ['Admin'],
        description: 'Delete a chapter',
        params: ID_PARAM,
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, tenantMiddleware],
    },
    async (request) => {
      const idParse = IdParamSchema.safeParse(request.params.id);
      if (!idParse.success) badRequest('Invalid chapter id');
      const rowId = idParse.data;

      const { tenantId, db } = requireTenant(request);
      const log = createAutoLogger(tenantId);

      const row = await db.selectFrom('chapters').select(['id', 'vod_id']).where('id', '=', rowId).executeTakeFirst();
      if (!row) notFound(`Chapter ${rowId} not found`);

      await db.deleteFrom('chapters').where('id', '=', rowId).execute();
      await invalidateVodByDbId(tenantId, db, row.vod_id);
      log.info({ chapterId: rowId, vodId: row.vod_id }, 'Deleted chapter');
      return ok({ message: `Deleted chapter ${rowId}`, id: rowId });
    }
  );

  // ── Games ───────────────────────────────────────────────────────────────────
  fastify.post<{ Params: { tenantId: string }; Body: GameCreateBody }>(
    '/games',
    {
      schema: {
        tags: ['Admin'],
        description: 'Create a game for a VOD',
        params: TENANT_PARAM,
        body: {
          type: 'object',
          properties: {
            vod_id: { type: 'integer' },
            start: { type: 'number' },
            duration: { type: 'number' },
            end: { type: 'number' },
            video_provider: { type: 'string', nullable: true },
            video_id: { type: 'string', nullable: true },
            thumbnail_url: { type: 'string', nullable: true },
            game_id: { type: 'string', nullable: true },
            game_name: { type: 'string', nullable: true },
            title: { type: 'string', nullable: true },
            chapter_image: { type: 'string', nullable: true },
          },
          required: ['vod_id', 'start', 'end'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, tenantMiddleware],
    },
    async (request) => {
      const { tenantId, db } = requireTenant(request);
      const parsed = AdminGameUpsertSchema.parse(request.body);
      await assertVodExists(db, parsed.vod_id);

      const created = (await db
        .insertInto('games')
        .values({
          vod_id: parsed.vod_id,
          start: parsed.start,
          duration: parsed.duration,
          end: parsed.end,
          video_provider: parsed.video_provider,
          video_id: parsed.video_id,
          thumbnail_url: parsed.thumbnail_url,
          game_id: parsed.game_id,
          game_name: parsed.game_name,
          title: parsed.title,
          chapter_image: parsed.chapter_image,
        })
        .returning(['id', 'vod_id', 'start', 'duration', 'end', 'game_id', 'game_name', 'title'])
        .executeTakeFirst()) as SelectableGames;

      await invalidateVodByDbId(tenantId, db, created.vod_id);
      return ok(created);
    }
  );

  fastify.patch<{ Params: { tenantId: string; id: string }; Body: GameUpdateBody }>(
    '/games/:id',
    {
      schema: {
        tags: ['Admin'],
        description: 'Update a game',
        params: ID_PARAM,
        body: {
          type: 'object',
          properties: {
            start: { type: 'number' },
            duration: { type: 'number' },
            end: { type: 'number' },
            video_provider: { type: 'string', nullable: true },
            video_id: { type: 'string', nullable: true },
            thumbnail_url: { type: 'string', nullable: true },
            game_id: { type: 'string', nullable: true },
            game_name: { type: 'string', nullable: true },
            title: { type: 'string', nullable: true },
            chapter_image: { type: 'string', nullable: true },
          },
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, tenantMiddleware],
    },
    async (request) => {
      const idParse = IdParamSchema.safeParse(request.params.id);
      if (!idParse.success) badRequest('Invalid game id');
      const rowId = idParse.data;

      const { tenantId, db } = requireTenant(request);
      const log = createAutoLogger(tenantId);

      const row = await db.selectFrom('games').select(['id', 'vod_id']).where('id', '=', rowId).executeTakeFirst();
      if (!row) notFound(`Game ${rowId} not found`);

      const parsed = AdminGameUpdateSchema.parse(request.body);
      const patch: UpdateableGames = {};
      if (parsed.start !== undefined) patch.start = parsed.start;
      if (parsed.duration !== undefined) patch.duration = parsed.duration;
      if (parsed.end !== undefined) patch.end = parsed.end;
      if (parsed.video_provider !== undefined) patch.video_provider = parsed.video_provider;
      if (parsed.video_id !== undefined) patch.video_id = parsed.video_id;
      if (parsed.thumbnail_url !== undefined) patch.thumbnail_url = parsed.thumbnail_url;
      if (parsed.game_id !== undefined) patch.game_id = parsed.game_id;
      if (parsed.game_name !== undefined) patch.game_name = parsed.game_name;
      if (parsed.title !== undefined) patch.title = parsed.title;
      if (parsed.chapter_image !== undefined) patch.chapter_image = parsed.chapter_image;

      if (Object.keys(patch).length === 0) badRequest('No fields to update');

      const updated = (await db
        .updateTable('games')
        .set(patch)
        .where('id', '=', rowId)
        .returning(['id', 'vod_id', 'start', 'duration', 'end', 'game_id', 'game_name', 'title'])
        .executeTakeFirst()) as SelectableGames;

      await invalidateVodByDbId(tenantId, db, row.vod_id);
      log.info({ gameId: rowId, vodId: row.vod_id }, 'Updated game');
      return ok(updated);
    }
  );

  fastify.delete<{ Params: { tenantId: string; id: string } }>(
    '/games/:id',
    {
      schema: {
        tags: ['Admin'],
        description: 'Delete a game',
        params: ID_PARAM,
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, tenantMiddleware],
    },
    async (request) => {
      const idParse = IdParamSchema.safeParse(request.params.id);
      if (!idParse.success) badRequest('Invalid game id');
      const rowId = idParse.data;

      const { tenantId, db } = requireTenant(request);
      const log = createAutoLogger(tenantId);

      const row = await db.selectFrom('games').select(['id', 'vod_id']).where('id', '=', rowId).executeTakeFirst();
      if (!row) notFound(`Game ${rowId} not found`);

      await db.deleteFrom('games').where('id', '=', rowId).execute();
      await invalidateVodByDbId(tenantId, db, row.vod_id);
      log.info({ gameId: rowId, vodId: row.vod_id }, 'Deleted game');
      return ok({ message: `Deleted game ${rowId}`, id: rowId });
    }
  );

  // ── VOD uploads ─────────────────────────────────────────────────────────────
  fastify.post<{ Params: { tenantId: string }; Body: UploadCreateBody }>(
    '/vod-uploads',
    {
      schema: {
        tags: ['Admin'],
        description: 'Create a vod_upload record for a VOD',
        params: TENANT_PARAM,
        body: {
          type: 'object',
          properties: {
            vod_id: { type: 'integer' },
            upload_id: { type: 'string' },
            type: { type: 'string', nullable: true },
            duration: { type: 'number' },
            part: { type: 'integer' },
            status: { type: 'string' },
            thumbnail_url: { type: 'string', nullable: true },
          },
          required: ['vod_id', 'upload_id'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, tenantMiddleware],
    },
    async (request) => {
      const { tenantId, db } = requireTenant(request);
      const parsed = AdminVodUploadUpsertSchema.parse(request.body);
      await assertVodExists(db, parsed.vod_id);

      const created = (await db
        .insertInto('vod_uploads')
        .values({
          vod_id: parsed.vod_id,
          upload_id: parsed.upload_id,
          type: parsed.type,
          duration: parsed.duration,
          part: parsed.part,
          status: parsed.status,
          thumbnail_url: parsed.thumbnail_url,
        })
        .returning(['id', 'vod_id', 'upload_id', 'type', 'duration', 'part', 'status', 'thumbnail_url'])
        .executeTakeFirst()) as SelectableVodUploads;

      await invalidateVodByDbId(tenantId, db, created.vod_id);
      return ok(created);
    }
  );

  fastify.patch<{ Params: { tenantId: string; id: string }; Body: UploadUpdateBody }>(
    '/vod-uploads/:id',
    {
      schema: {
        tags: ['Admin'],
        description: 'Update a vod_upload record',
        params: ID_PARAM,
        body: {
          type: 'object',
          properties: {
            upload_id: { type: 'string' },
            type: { type: 'string', nullable: true },
            duration: { type: 'number' },
            part: { type: 'integer' },
            status: { type: 'string' },
            thumbnail_url: { type: 'string', nullable: true },
          },
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, tenantMiddleware],
    },
    async (request) => {
      const idParse = IdParamSchema.safeParse(request.params.id);
      if (!idParse.success) badRequest('Invalid vod_upload id');
      const rowId = idParse.data;

      const { tenantId, db } = requireTenant(request);
      const log = createAutoLogger(tenantId);

      const row = await db
        .selectFrom('vod_uploads')
        .select(['id', 'vod_id'])
        .where('id', '=', rowId)
        .executeTakeFirst();
      if (!row) notFound(`VOD upload ${rowId} not found`);

      const parsed = AdminVodUploadUpdateSchema.parse(request.body);
      const patch: UpdateableVodUploads = {};
      if (parsed.upload_id !== undefined) patch.upload_id = parsed.upload_id;
      if (parsed.type !== undefined) patch.type = parsed.type;
      if (parsed.duration !== undefined) patch.duration = parsed.duration;
      if (parsed.part !== undefined) patch.part = parsed.part;
      if (parsed.status !== undefined) patch.status = parsed.status;
      if (parsed.thumbnail_url !== undefined) patch.thumbnail_url = parsed.thumbnail_url;

      if (Object.keys(patch).length === 0) badRequest('No fields to update');

      const updated = (await db
        .updateTable('vod_uploads')
        .set(patch)
        .where('id', '=', rowId)
        .returning(['id', 'vod_id', 'upload_id', 'type', 'duration', 'part', 'status', 'thumbnail_url'])
        .executeTakeFirst()) as SelectableVodUploads;

      await invalidateVodByDbId(tenantId, db, row.vod_id);
      log.info({ uploadId: rowId, vodId: row.vod_id }, 'Updated vod_upload');
      return ok(updated);
    }
  );

  fastify.delete<{ Params: { tenantId: string; id: string } }>(
    '/vod-uploads/:id',
    {
      schema: {
        tags: ['Admin'],
        description: 'Delete a vod_upload record',
        params: ID_PARAM,
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, tenantMiddleware],
    },
    async (request) => {
      const idParse = IdParamSchema.safeParse(request.params.id);
      if (!idParse.success) badRequest('Invalid vod_upload id');
      const rowId = idParse.data;

      const { tenantId, db } = requireTenant(request);
      const log = createAutoLogger(tenantId);

      const row = await db
        .selectFrom('vod_uploads')
        .select(['id', 'vod_id'])
        .where('id', '=', rowId)
        .executeTakeFirst();
      if (!row) notFound(`VOD upload ${rowId} not found`);

      await db.deleteFrom('vod_uploads').where('id', '=', rowId).execute();
      await invalidateVodByDbId(tenantId, db, row.vod_id);
      log.info({ uploadId: rowId, vodId: row.vod_id }, 'Deleted vod_upload');
      return ok({ message: `Deleted vod_upload ${rowId}`, id: rowId });
    }
  );

  // ── Emotes (one jsonb row per VOD) ─────────────────────────────────────────
  fastify.put<{ Params: { tenantId: string; dbId: string }; Body: EmoteBody }>(
    '/vods/:dbId/emotes',
    {
      schema: {
        tags: ['Admin'],
        description: 'Replace the emote data for a VOD (FFZ, BTTV, 7TV)',
        params: {
          type: 'object',
          properties: {
            tenantId: { type: 'string', description: 'Tenant ID' },
            dbId: { type: 'integer', description: 'Internal numeric VOD ID' },
          },
          required: ['tenantId', 'dbId'],
        },
        body: {
          type: 'object',
          properties: {
            ffz_emotes: { type: 'array' },
            bttv_emotes: { type: 'array' },
            seventv_emotes: { type: 'array' },
          },
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, tenantMiddleware],
    },
    async (request) => {
      const dbIdParse = IdParamSchema.safeParse(request.params.dbId);
      if (!dbIdParse.success) badRequest('Invalid VOD id');
      const dbId = dbIdParse.data;

      const { tenantId, db } = requireTenant(request);
      const log = createAutoLogger(tenantId);

      const vod = await db.selectFrom('vods').select('id').where('id', '=', dbId).executeTakeFirst();
      if (!vod) notFound(`VOD ${dbId} not found`);

      const parsed = EmoteUpsertSchema.parse({ ...request.body, vod_id: dbId });

      await db
        .insertInto('emotes')
        .values({
          vod_id: dbId,
          ffz_emotes: JSON.stringify(parsed.ffz_emotes),
          bttv_emotes: JSON.stringify(parsed.bttv_emotes),
          seventv_emotes: JSON.stringify(parsed.seventv_emotes),
        })
        .onConflict((oc) =>
          oc.column('vod_id').doUpdateSet({
            ffz_emotes: JSON.stringify(parsed.ffz_emotes),
            bttv_emotes: JSON.stringify(parsed.bttv_emotes),
            seventv_emotes: JSON.stringify(parsed.seventv_emotes),
          })
        )
        .execute();

      await invalidateEmoteCache(tenantId, dbId);
      await invalidateVodByDbId(tenantId, db, dbId);
      log.info({ dbId }, 'Replaced VOD emotes');
      return ok({ message: `Emotes updated for VOD ${dbId}`, dbId });
    }
  );

  return fastify;
}
