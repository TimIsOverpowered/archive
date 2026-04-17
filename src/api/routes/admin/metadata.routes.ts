import type { FastifyInstance } from 'fastify';
import createRateLimitMiddleware from '../../middleware/rate-limit.js';
import adminApiKeyMiddleware from '../../middleware/admin-api-key.js';
import { tenantMiddleware, platformValidationMiddleware, type TenantPlatformContext } from '../../middleware/tenant-platform.js';
import { saveVodChapters } from '../../../services/twitch/index.js';
import { adminRateLimiter } from '../../plugins/redis.plugin.js';
import { badRequest, notFound } from '../../../utils/http-error.js';
import type { Platform } from '../../../types/platforms.js';
import { PLATFORM_VALUES, PLATFORMS } from '../../../types/platforms.js';
import { findVodRecord } from './utils/vod-helpers.js';
import { fetchAndSaveEmotes } from '../../../services/emotes.js';
import { triggerChatDownload } from '../../../workers/jobs/chat.job';

type RouteParams = { tenantId: string };

interface ChaptersBody {
  vodId: string;
  platform: Platform;
}

interface SaveBody {
  vodId: string;
  platform: Platform;
  forceRerun?: boolean;
}

export default async function metadataFetchingRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  if (!adminRateLimiter) {
    throw new Error('Rate limiter not initialized');
  }

  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: adminRateLimiter });

  // Fetch and save game chapters from Twitch API (Twitch only)
  fastify.post<{ Params: RouteParams; Body: ChaptersBody }>(
    '/vods/chapters',
    {
      schema: {
        tags: ['Admin'],
        description: 'Fetch and save game chapters from Twitch API (Twitch only)',
        params: { type: 'object', properties: { tenantId: { type: 'string', description: 'Tenant ID' } }, required: ['tenantId'] },
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
      const { db, platform } = request.tenant as TenantPlatformContext;
      const { vodId } = request.body;

      const vodRecord = await findVodRecord(db, vodId, platform);

      if (!vodRecord) notFound(`VOD ${vodId} not found`);

      if (platform !== PLATFORMS.TWITCH) {
        return { data: { message: `Chapter fetching only supported for Twitch VODs`, vodId, platform } };
      }

      const durationSeconds = vodRecord.duration ? parseInt(vodRecord.duration.toString()) : 0;
      const savedCount = await saveVodChapters(request.tenant as TenantPlatformContext, vodRecord.id, vodId, durationSeconds);

      if (savedCount === 0) {
        return { data: { message: `No chapters found for ${vodId}`, vodId, count: 0 } };
      }

      return { data: { message: `Saved chapters for ${vodId}`, vodId, count: savedCount } };
    }
  );

  // Fetch and save emote metadata for a VOD
  fastify.post<{ Params: RouteParams; Body: SaveBody }>(
    '/vods/emotes',
    {
      schema: {
        tags: ['Admin'],
        description: 'Fetch and save emote metadata for a VOD',
        params: { type: 'object', properties: { tenantId: { type: 'string', description: 'Tenant ID' } }, required: ['tenantId'] },
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
      const { db, platform, config } = request.tenant as TenantPlatformContext;
      const { vodId } = request.body;

      const vodRecord = await findVodRecord(db, vodId, platform);

      if (!vodRecord) notFound(`VOD ${vodId} not found`);

      // Queue emote save job (fire-and-forget within request context)
      const platformId = config?.[platform]?.id;

      if (!platformId) badRequest(`No platform ID available for ${platform} ${vodId}`);

      await fetchAndSaveEmotes(request.tenant as TenantPlatformContext, vodRecord.id, platform, platformId);

      return { data: { message: `Emote saving completed for ${vodId}`, vodId, platform } };
    }
  );

  // Fetch and save emote metadata for a VOD
  fastify.post<{ Params: RouteParams; Body: SaveBody }>(
    '/vods/chat',
    {
      schema: {
        tags: ['Admin'],
        description: 'Fetch and save chat data for a VOD',
        params: { type: 'object', properties: { tenantId: { type: 'string', description: 'Tenant ID' } }, required: ['tenantId'] },
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
      const { db, platform, config, tenantId } = request.tenant as TenantPlatformContext;
      const { vodId, forceRerun = false } = request.body;

      const vodRecord = await findVodRecord(db, vodId, platform);

      if (!vodRecord) notFound(`VOD ${vodId} not found`);

      // Queue emote save job (fire-and-forget within request context)
      const platformId = config?.[platform]?.id;

      if (!platformId) badRequest(`No platform ID available for ${platform} ${vodId}`);

      const jobId = await triggerChatDownload(tenantId, platformId, vodRecord.id, vodId, platform, Math.round(vodRecord.duration), config?.[platform]?.username, forceRerun);

      return { data: { message: `Queueing chat job ${vodId}`, vodId, platform, jobId } };
    }
  );

  return fastify;
}
