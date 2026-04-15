import type { FastifyInstance } from 'fastify';
import createRateLimitMiddleware from '../../middleware/rate-limit';
import adminApiKeyMiddleware from '../../middleware/admin-api-key';
import { tenantMiddleware, platformValidationMiddleware, type TenantPlatformContext } from '../../middleware/tenant-platform';
import { saveVodChapters } from '../../../services/twitch/index.js';
import { adminRateLimiter } from '../../plugins/redis.plugin';
import { badRequest, notFound } from '../../../utils/http-error';
import type { Platform } from '../../../types/platforms.js';
import { PLATFORM_VALUES, PLATFORMS } from '../../../types/platforms.js';
import { findVodRecord } from './utils/vod-helpers.js';
import { fetchAndSaveEmotes } from '../../../services/emotes';

type RouteParams = { tenantId: string };

interface ChaptersBody {
  vodId: string;
  platform: Platform;
}

interface EmotesSaveBody {
  vodId: string;
  platform: Platform;
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
      const { tenantId, client, platform } = request.tenant as TenantPlatformContext;
      const { vodId } = request.body;

      const vodRecord = await findVodRecord(client, vodId, platform);

      if (!vodRecord) notFound(`VOD ${vodId} not found`);

      if (platform !== PLATFORMS.TWITCH) {
        return { data: { message: `Chapter fetching only supported for Twitch VODs`, vodId, platform } };
      }

      const durationSeconds = vodRecord.duration ? parseInt(vodRecord.duration.toString()) : 0;
      const savedCount = await saveVodChapters(vodRecord.id, vodId, tenantId, durationSeconds, client);

      if (savedCount === 0) {
        return { data: { message: `No chapters found for ${vodId}`, vodId, count: 0 } };
      }

      return { data: { message: `Saved chapters for ${vodId}`, vodId, count: savedCount } };
    }
  );

  // Fetch and save emote metadata for a VOD
  fastify.post<{ Params: RouteParams; Body: EmotesSaveBody }>(
    '/vods/emotes/save',
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
      const { tenantId, client, platform, config } = request.tenant as TenantPlatformContext;
      const { vodId } = request.body;

      const vodRecord = await findVodRecord(client, vodId, platform);

      if (!vodRecord) notFound(`VOD ${vodId} not found`);

      // Queue emote save job (fire-and-forget within request context)
      const platformId = config?.[platform]?.id;

      if (!platformId) badRequest(`No platform ID available for ${platform} ${vodId}`);

      await fetchAndSaveEmotes(tenantId, vodRecord.id, platform, platformId, client);

      return { data: { message: `Emote saving completed for ${vodId}`, vodId, platform } };
    }
  );

  return fastify;
}
