import type { FastifyInstance } from 'fastify';
import { getPlatformConfig, getDisplayName } from '../../../config/types.js';
import { findVodByPlatformId } from '../../../db/queries/vods.js';
import { fetchAndSaveEmotes } from '../../../services/emotes.js';
import { saveVodChapters } from '../../../services/twitch/index.js';
import type { Platform } from '../../../types/platforms.js';
import { PLATFORM_VALUES, PLATFORMS } from '../../../types/platforms.js';
import { notFound, badRequest } from '../../../utils/http-error.js';
import { triggerChatDownload } from '../../../workers/jobs/chat.job.js';
import adminApiKeyMiddleware from '../../middleware/admin-api-key.js';
import createRateLimitMiddleware from '../../middleware/rate-limit.js';
import {
  tenantMiddleware,
  platformValidationMiddleware,
  asTenantPlatformContext,
  requireTenant,
} from '../../middleware/tenant-platform.js';
import { ok } from '../../response.js';

/** Route params shared by metadata endpoints. */
type RouteParams = { tenantId: string };

/** Body for fetching and saving game chapters from Twitch API. */
interface ChaptersBody {
  vodId: string;
  platform: Platform;
}

/** Body for fetching and saving emote/chat metadata for a VOD. */
interface SaveBody {
  vodId: string;
  platform: Platform;
  forceRerun?: boolean;
}

/**
 * Register metadata fetching routes: chapters, emotes, chat.
 * Requires admin API key authentication, tenant middleware, and rate limiting.
 */
export default function metadataFetchingRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: fastify.adminRateLimiter });

  // Fetch and save game chapters from Twitch API (Twitch only)
  fastify.post<{ Params: RouteParams; Body: ChaptersBody }>(
    '/vods/chapters',
    {
      schema: {
        tags: ['Admin'],
        description: 'Fetch and save game chapters from Twitch API (Twitch only)',
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
      const { db, platform } = tenantCtx;
      const { vodId } = request.body;

      const vodRecord = await findVodByPlatformId(db, vodId, platform);

      if (!vodRecord) notFound(`VOD ${vodId} not found`);

      if (platform !== PLATFORMS.TWITCH) {
        return ok({ message: `Chapter fetching only supported for Twitch VODs`, vodId, platform });
      }

      const durationSeconds =
        vodRecord.duration != null && vodRecord.duration > 0 ? parseInt(vodRecord.duration.toString()) : 0;
      const savedCount = await saveVodChapters(tenantCtx, vodRecord.id, vodId, durationSeconds);

      if (savedCount === 0) {
        return ok({ message: `No chapters found for ${vodId}`, vodId, count: 0 });
      }

      return ok({ message: `Saved chapters for ${vodId}`, vodId, count: savedCount });
    }
  );

  // Fetch and save emote metadata for a VOD
  fastify.post<{ Params: RouteParams; Body: SaveBody }>(
    '/vods/emotes',
    {
      schema: {
        tags: ['Admin'],
        description: 'Fetch and save emote metadata for a VOD',
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
      const { db, platform, config } = tenantCtx;
      const { vodId } = request.body;

      const vodRecord = await findVodByPlatformId(db, vodId, platform);

      if (!vodRecord) notFound(`VOD ${vodId} not found`);

      // Queue emote save job (fire-and-forget within request context)
      const platformId = getPlatformConfig(config, platform)?.id;

      if (platformId == null) badRequest(`No platform ID available for ${platform} ${vodId}`);

      await fetchAndSaveEmotes(tenantCtx, vodRecord.id, platform, platformId);

      return ok({ message: `Emote saving completed for ${vodId}`, vodId, platform });
    }
  );

  // Fetch and save emote metadata for a VOD
  fastify.post<{ Params: RouteParams; Body: SaveBody }>(
    '/vods/chat',
    {
      schema: {
        tags: ['Admin'],
        description: 'Fetch and save chat data for a VOD',
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
            forceRerun: { type: 'boolean', description: 'Force re-download even if already complete', default: false },
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
      const { db, platform, config, tenantId } = tenantCtx;
      const { vodId, forceRerun = false } = request.body;

      const vodRecord = await findVodByPlatformId(db, vodId, platform);

      if (!vodRecord) notFound(`VOD ${vodId} not found`);

      // Queue emote save job (fire-and-forget within request context)
      const platformCfg = getPlatformConfig(config, platform);
      const platformId = platformCfg?.id;

      if (platformId == null) badRequest(`No platform ID available for ${platform} ${vodId}`);

      const jobId = await triggerChatDownload({
        tenantId,
        displayName: getDisplayName(config),
        platformUserId: platformId,
        dbId: vodRecord.id,
        vodId,
        platform,
        duration: Math.round(vodRecord.duration),
        platformUsername: platformCfg?.username,
        forceRerun,
      });

      return ok({ message: `Queueing chat job ${vodId}`, vodId, platform, jobId });
    }
  );

  return fastify;
}
