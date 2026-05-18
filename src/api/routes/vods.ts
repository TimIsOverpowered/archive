import { FastifyInstance } from 'fastify';
import type { ReadonlyKysely } from 'kysely/readonly';
import { z } from 'zod';
import type { StreamerDB } from '../../db/streamer-types.js';
import { getEmotesByVodId } from '../../services/emotes.js';
import { getVods, getVodById, getVodByPlatformId, VodQuerySchema } from '../../services/vods.service.js';
import { PLATFORM_VALUES, type Platform } from '../../types/platforms.js';
import { notFound } from '../../utils/http-error.js';
import createRateLimitMiddleware from '../middleware/rate-limit.js';
import { tenantMiddleware, requireTenant } from '../middleware/tenant-platform.js';
import { ok, okPaginated } from '../response.js';
import { createRequestController, resolveVodDbId } from '../route-helpers.js';

const VodIdParamSchema = z.string().min(1).max(100);

/** Options for registering the VODs routes plugin. */
interface VodRoutesOptions {
  prefix: string;
}

/**
 * Register VODs routes: list VODs, get by ID, get by platform ID, get emotes.
 * All routes require tenant middleware and rate limiting.
 */
export default function vodsRoutes(fastify: FastifyInstance, _options: VodRoutesOptions) {
  const rateLimitMiddleware = createRateLimitMiddleware({
    limiter: fastify.publicRateLimiter,
  });

  fastify.get(
    '/:tenantId/vods',
    {
      schema: {
        tags: ['VODs'],
        description: 'List all VODs for a streamer with filtering and pagination',
        params: {
          type: 'object',
          properties: {
            tenantId: { type: 'string', description: 'Tenant ID' },
          },
          required: ['tenantId'],
        },
        query: {
          type: 'object',
          properties: {
            platform: { type: 'string', enum: PLATFORM_VALUES, description: 'Filter by source platform' },
            from: { type: 'string', format: 'date-time', description: 'Filter VODs after date (ISO)' },
            to: { type: 'string', format: 'date-time', description: 'Filter VODs before date (ISO)' },
            uploaded: { type: 'string', enum: ['youtube'], description: 'Only VODs with YouTube uploads' },
            game: { type: 'string', description: 'Fuzzy search in games.game_name' },
            game_id: { type: 'string', description: 'Exact match by game_id (via chapters)' },
            title: { type: 'string', description: 'Full-text search in VOD title' },
            chapter: { type: 'string', description: 'Full-text search in chapter names' },
            page: { type: 'integer', minimum: 1, default: 1, description: 'Page number' },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Items per page' },
            sort: { type: 'string', enum: ['created_at', 'duration'], default: 'created_at' },
            order: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
          },
        },
      },
      onRequest: [rateLimitMiddleware, tenantMiddleware],
    },
    async (request) => {
      const controller = createRequestController(request);

      try {
        const tenantCtx = requireTenant(request);
        const { tenantId, db } = tenantCtx;

        const query = VodQuerySchema.parse(request.query);
        const { vods, total } = await getVods(db as unknown as ReadonlyKysely<StreamerDB>, tenantId, query, {
          signal: controller.signal,
        });

        return okPaginated(vods, {
          page: query.page,
          limit: query.limit,
          total,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        throw err;
      }
    }
  );

  fastify.get<{ Params: { tenantId: string; vodId: string } }>(
    '/:tenantId/vods/:vodId',
    {
      schema: {
        tags: ['VODs'],
        description: 'Get a single VOD by ID (Supports new integer IDs and legacy platform IDs)',
        params: {
          type: 'object',
          properties: {
            tenantId: { type: 'string', description: 'Tenant ID' },
            vodId: { type: 'string', minLength: 1, maxLength: 100, description: 'VOD ID' },
          },
          required: ['tenantId', 'vodId'],
        },
      },
      onRequest: [rateLimitMiddleware, tenantMiddleware],
    },
    async (request) => {
      const controller = createRequestController(request);

      try {
        const { vodId } = request.params;
        const tenantCtx = requireTenant(request);
        const { tenantId, db } = tenantCtx;

        const vodIdParsed = VodIdParamSchema.safeParse(vodId);
        if (!vodIdParsed.success) {
          notFound('VOD not found');
        }

        const actualDbId = await resolveVodDbId(db, vodIdParsed.data, controller.signal);

        const vod = await getVodById(db, tenantId, actualDbId, { signal: controller.signal });
        if (vod == null) {
          notFound('VOD not found');
        }
        return ok(vod);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        throw err;
      }
    }
  );

  fastify.get<{ Params: { tenantId: string; platform: Platform; platformVodId: string } }>(
    '/:tenantId/vods/:platform/:platformVodId',
    {
      schema: {
        tags: ['VODs'],
        description: 'Get a single VOD by platform-specific ID',
        params: {
          type: 'object',
          properties: {
            tenantId: { type: 'string', description: 'Tenant ID' },
            platform: { type: 'string', enum: PLATFORM_VALUES, description: 'Platform' },
            platformVodId: { type: 'string', description: 'Platform-specific VOD ID' },
          },
          required: ['tenantId', 'platform', 'platformVodId'],
        },
      },
      onRequest: [rateLimitMiddleware, tenantMiddleware],
    },
    async (request) => {
      const controller = createRequestController(request);

      try {
        const { platform, platformVodId } = request.params;
        const tenantCtx = requireTenant(request);
        const { tenantId, db } = tenantCtx;

        const vod = await getVodByPlatformId(
          db as unknown as ReadonlyKysely<StreamerDB>,
          tenantId,
          platform,
          platformVodId,
          { signal: controller.signal }
        );

        if (!vod) {
          notFound('VOD not found');
        }

        return ok(vod);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        throw err;
      }
    }
  );

  fastify.get<{ Params: { tenantId: string; vodId: string } }>(
    '/:tenantId/vods/:vodId/emotes',
    {
      schema: {
        tags: ['VODs'],
        description: 'Get emotes for a specific VOD (used for chat replay)',
        params: {
          type: 'object',
          properties: {
            tenantId: { type: 'string', description: 'Tenant ID' },
            vodId: { type: 'string', minLength: 1, maxLength: 100, description: 'VOD ID' },
          },
          required: ['tenantId', 'vodId'],
        },
      },
      onRequest: [rateLimitMiddleware, tenantMiddleware],
    },
    async (request) => {
      const controller = createRequestController(request);

      try {
        const { vodId } = request.params;
        const tenantCtx = requireTenant(request);
        const { tenantId, db } = tenantCtx;

        const vodIdParsed = VodIdParamSchema.safeParse(vodId);
        if (!vodIdParsed.success) {
          notFound('VOD not found');
        }

        const actualDbId = await resolveVodDbId(db, vodIdParsed.data, controller.signal);

        const emotes = await getEmotesByVodId(db, tenantId, actualDbId);

        if (!emotes) {
          notFound('Emotes not found for this VOD');
        }

        return ok(emotes);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        throw err;
      }
    }
  );
}
