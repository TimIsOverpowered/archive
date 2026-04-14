import type { FastifyInstance } from 'fastify';
import createRateLimitMiddleware from '../../middleware/rate-limit';
import adminApiKeyMiddleware from '../../middleware/admin-api-key';
import { tenantMiddleware, platformValidationMiddleware, type TenantPlatformContext } from '../../middleware/tenant-platform';
import type { VodData as TwitchVodData } from '../../../services/twitch/index.js';
import { saveVodChapters } from '../../../services/twitch/index.js';
import { adminRateLimiter } from '../../plugins/redis.plugin';
import { createAutoLogger } from '../../../utils/auto-tenant-logger.js';
import { notFound } from '../../../utils/http-error';
import type { Platform } from '../../../types/platforms.js';
import { PLATFORMS } from '../../../types/platforms.js';
import { findVodRecord } from './utils/vod-helpers.js';

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
            platform: { type: 'string', enum: Object.values(PLATFORMS), description: 'Source platform' },
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

      if (platform !== 'twitch') {
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
            platform: { type: 'string', enum: Object.values(PLATFORMS), description: 'Source platform' },
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
      const log = createAutoLogger(tenantId);

      const vodRecord = await findVodRecord(client, vodId, platform);

      if (!vodRecord) notFound(`VOD ${vodId} not found`);

      let channelId: string | undefined;

      // Only supported for Twitch with stream_id available
      if (platform === 'twitch' && vodRecord.stream_id) {
        const twitch = await import('../../../services/twitch');
        const vodData: TwitchVodData = await twitch.getVodData(vodId, tenantId);

        channelId = vodData.user_id;

        if (channelId) {
          log.info(`Fetching emotes for channel ${channelId}`);

          const EmoteModule = await import('../../../services/emotes');
          await EmoteModule.fetchAndSaveEmotes(tenantId, vodRecord.id, platform, channelId);

          log.info(`Successfully fetched and saved emotes`);
        } else {
          log.warn(`No channel ID available for Twitch VOD ${vodId}`);
        }
      } else if (platform !== 'twitch') {
        log.info(`Emote fetching only supported for Twitch platform`);
      }

      return { data: { message: `Emote saving completed for ${vodId}`, vodId, platform } };
    }
  );

  return fastify;
}
