import type { FastifyInstance } from 'fastify';

import dayjs from 'dayjs';
import durationPlugin from 'dayjs/plugin/duration';
import createRateLimitMiddleware from '../../middleware/rate-limit';
import adminApiKeyMiddleware from '../../middleware/admin-api-key';
import { tenantMiddleware, platformValidationMiddleware, type TenantPlatformContext } from '../../middleware/tenant-platform';
import type { VodData as TwitchVodData } from '../../../services/twitch/index.js';
import { adminRateLimiter } from '../../plugins/redis.plugin';
import { createAutoLogger } from '../../../utils/auto-tenant-logger.js';
import { notFound } from '../../../utils/http-error';
import type { Platform } from '../../../types/platforms.js';
import { PLATFORMS } from '../../../types/platforms.js';

dayjs.extend(durationPlugin);

type RouteParams = { tenantId: string };

interface ChaptersBody {
  vodId: string;
  platform: Platform;
}

interface EmotesSaveBody {
  vodId: string;
  platform: Platform;
}

interface ChapterGame {
  id?: string;
  displayName?: string;
}

interface ChapterNode {
  positionMilliseconds: number;
  durationMilliseconds: number;
  details?: {
    game?: ChapterGame;
  };
}

interface ChapterEdge {
  node?: ChapterNode;
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
      const log = createAutoLogger(tenantId);

      const { findVodRecord } = await import('./utils/vod-helpers.js');

      const vodRecord = await findVodRecord(client, vodId, platform);

      if (!vodRecord) notFound(`VOD ${vodId} not found`);

      // Chapters only supported for Twitch VODs
      if (platform !== 'twitch') {
        return { data: { message: `Chapter fetching only supported for Twitch VODs`, vodId, platform } };
      }

      const durationSeconds = vodRecord.duration ? parseInt(vodRecord.duration.toString()) : 0;

      let savedCount = 0;
      let chapterEdges: ChapterEdge[] | null = [];

      try {
        const twitch = await import('../../../services/twitch');
        const rawChapters = (await twitch.getChapters(vodId)) as ChapterEdge[] | null;
        chapterEdges = rawChapters || [];
      } catch {
        log.warn(`Failed to fetch chapter data from Twitch API`);
      }

      if (chapterEdges && chapterEdges.length > 0) {
        // Multiple chapters case - process each one
        for (const chapter of chapterEdges) {
          try {
            const node = chapter.node;
            if (!node || !node.details?.game) continue;

            const gameNode = node.details.game;
            let image: string | null = null;

            // Fetch box art URL from separate API call
            try {
              const twitch = await import('../../../services/twitch');
              if (gameNode.id) {
                const gameData = await twitch.getGameData(gameNode.id, tenantId);
                if (gameData && 'box_art_url' in gameData) {
                  image = String(gameData.box_art_url).replace('{width}x{height}', '40x53');
                }
              }
            } catch {
              log.warn(`Failed to fetch game data`);
            }

            const startSeconds = node.positionMilliseconds / 1000;
            let endSeconds: number;

            if (node.durationMilliseconds === 0) {
              // Last chapter - extend to end of VOD
              endSeconds = durationSeconds - startSeconds;
            } else {
              endSeconds = node.durationMilliseconds / 1000;
            }

            const durationFormatted = dayjs.duration(node.durationMilliseconds, 'ms').format('HH:mm:ss');

            await client.chapter.create({
              data: {
                vod_id: vodRecord.id,
                name: gameNode.displayName || null,
                duration: durationFormatted,
                start: startSeconds,
                end: endSeconds,
                image,
                game_id: gameNode.id ? String(gameNode.id) : undefined,
              },
            });

            savedCount++;
          } catch {
            log.warn(`Failed to save chapter`);
          }
        }
      } else {
        // Single chapter case - use getChapter fallback
        let chapterData: Record<string, unknown> | null = null;

        try {
          const twitch = await import('../../../services/twitch');
          chapterData = await twitch.getChapter(vodId);
        } catch {
          log.warn(`Failed to fetch single chapter data from Twitch API`);
        }

        if (chapterData && 'game' in chapterData) {
          const gameNode = chapterData.game as ChapterGame;
          let image: string | null = null;

          try {
            const twitch = await import('../../../services/twitch');
            if (gameNode.id) {
              const gameData = await twitch.getGameData(gameNode.id, tenantId);
              if (gameData && 'box_art_url' in gameData) {
                image = String(gameData.box_art_url).replace('{width}x{height}', '40x53');
              }
            }
          } catch {
            log.warn(`Failed to fetch game data`);
          }

          await client.chapter.create({
            data: {
              vod_id: vodRecord.id,
              name: gameNode.displayName || null,
              duration: '00:00:00',
              start: 0,
              end: durationSeconds,
              image,
              game_id: gameNode.id ? String(gameNode.id) : undefined,
            },
          });

          savedCount++;
        } else {
          return { data: { message: `No chapters found for ${vodId}`, vodId, count: 0 } };
        }
      }

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

      const { findVodRecord } = await import('./utils/vod-helpers.js');

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
