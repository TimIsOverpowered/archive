import { FastifyInstance } from 'fastify';
import { getVods, getVodById, getVodByPlatformId, VodQuerySchema } from '../../services/vods.service.js';
import { getEmotesByVodId } from '../../services/emotes.js';
import createRateLimitMiddleware from '../middleware/rate-limit.js';
import { RedisService } from '../../utils/redis-service.js';
import { HttpError } from '../../utils/http-error.js';
import { tenantMiddleware, requireTenant } from '../middleware/tenant-platform.js';
import { PLATFORM_VALUES, type Platform } from '../../types/platforms.js';
import { Db } from '../../constants.js';
import type { Kysely } from 'kysely';
import type { StreamerDB } from '../../db/streamer-types.js';

/** Options for registering the VODs routes plugin. */
interface VodRoutesOptions {
  prefix: string;
}

/**
 * Validate and fetch a VOD by numeric ID, throwing 404 on invalid/missing.
 */
async function fetchVodByIdSafe(vodId: string, db: Kysely<StreamerDB>, tenantId: string) {
  const vodIdNum = Number(vodId);
  if (isNaN(vodIdNum) || vodIdNum < 0 || vodIdNum > Db.INT32_MAX) {
    throw new HttpError(404, 'VOD not found', 'NOT_FOUND');
  }
  const vod = await getVodById(db, tenantId, vodIdNum);
  if (!vod) throw new HttpError(404, 'VOD not found', 'NOT_FOUND');
  return vod;
}

/**
 * Register VODs routes: list VODs, get by ID, get by platform ID, get emotes.
 * All routes require tenant middleware and rate limiting.
 */
export default function vodsRoutes(fastify: FastifyInstance, _options: VodRoutesOptions) {
  const publicRateLimiter = RedisService.requireLimiter('rate:vods');

  const rateLimitMiddleware = createRateLimitMiddleware({
    limiter: publicRateLimiter,
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
            game: { type: 'string', description: 'Fuzzy search in chapters.name' },
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
      const tenantCtx = requireTenant(request);
      const { tenantId, db } = tenantCtx;

      const query = VodQuerySchema.parse(request.query);
      const { vods, total } = await getVods(db, tenantId, query);

      return {
        data: vods,
        meta: {
          page: query.page,
          limit: query.limit,
          total,
        },
      };
    }
  );

  fastify.get<{ Params: { tenantId: string; vodId: string } }>(
    '/:tenantId/vods/:vodId',
    {
      schema: {
        tags: ['VODs'],
        description: 'Get a single VOD by ID',
        params: {
          type: 'object',
          properties: {
            tenantId: { type: 'string', description: 'Tenant ID' },
            vodId: { type: 'string', description: 'VOD ID' },
          },
          required: ['tenantId', 'vodId'],
        },
      },
      onRequest: [rateLimitMiddleware, tenantMiddleware],
    },
    async (request) => {
      const { tenantId, vodId } = request.params;
      const tenantCtx = requireTenant(request);
      const { db } = tenantCtx;
      const vod = await fetchVodByIdSafe(vodId, db, tenantId);
      return { data: vod };
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
      const { tenantId, platform, platformVodId } = request.params;
      const tenantCtx = requireTenant(request);
      const { db } = tenantCtx;

      const vod = await getVodByPlatformId(db, tenantId, platform, platformVodId);

      if (!vod) {
        throw new HttpError(404, 'VOD not found', 'NOT_FOUND');
      }

      return { data: vod };
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
            vodId: { type: 'string', description: 'VOD ID' },
          },
          required: ['tenantId', 'vodId'],
        },
      },
      onRequest: [rateLimitMiddleware, tenantMiddleware],
    },
    async (request) => {
      const { tenantId, vodId } = request.params;
      const tenantCtx = requireTenant(request);
      const { db } = tenantCtx;
      await fetchVodByIdSafe(vodId, db, tenantId);
      const emotes = await getEmotesByVodId(db, tenantId, Number(vodId));

      if (!emotes) {
        throw new HttpError(404, 'Emotes not found for this VOD', 'NOT_FOUND');
      }

      return { data: emotes };
    }
  );
}
