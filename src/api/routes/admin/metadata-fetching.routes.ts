import type { FastifyInstance } from 'fastify';
import { extractErrorDetails } from '../../../utils/error.js';
import dayjs from 'dayjs';
import durationPlugin from 'dayjs/plugin/duration';
import { getTenantConfig } from '../../../config/loader';
import createRateLimitMiddleware from '../../middleware/rate-limit';
import adminApiKeyMiddleware from '../../middleware/admin-api-key';
import { getClient } from '../../../db/client.js';
import type { VodData as TwitchVodData } from '../../../services/twitch.js';
import { adminRateLimiter } from '../../plugins/redis.plugin';
import { createAutoLogger } from '../../../utils/auto-tenant-logger.js';
import { notFound, serviceUnavailable, internalServerError } from '../../../utils/http-error';

dayjs.extend(durationPlugin);

type RouteParams = { id: string; vodId: string };

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

type StreamerDbClient = NonNullable<ReturnType<typeof getClient>>;

type VodRecord = { id: string; platform: 'twitch' | 'kick'; duration: number | string; stream_id?: string | null };

export default async function metadataFetchingRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  if (!adminRateLimiter) {
    throw new Error('Rate limiter not initialized');
  }

  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: adminRateLimiter });

  // Fetch and save game chapters from Twitch API (Twitch only)
  fastify.post<{ Params: RouteParams }>(
    '/:id/vods/:vodId/chapters',
    {
      schema: {
        tags: ['Admin'],
        description: 'Fetch and save game chapters from Twitch API (Twitch only)',
        params: { type: 'object', properties: { id: { type: 'string' }, vodId: { type: 'string' } }, required: ['id', 'vodId'] },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const tenantId = request.params.id;
      const vodId = request.params.vodId;
      const log = createAutoLogger(tenantId);

      try {
        const config = getTenantConfig(tenantId);

        if (!config) notFound('Tenant not found');

        const client: StreamerDbClient | undefined = getClient(tenantId);

        if (!client) {
          log.error('Database error: Database not available');
          serviceUnavailable('Database not available');
        }

        const vodIdNum = Number(vodId);

        const vodRecord: VodRecord | null = (await client.vod.findUnique({ where: { id: vodIdNum } })) as VodRecord | null;

        if (!vodRecord) notFound(`VOD ${vodId} not found`);

        // Chapters only supported for Twitch VODs
        if (vodRecord.platform !== 'twitch') {
          return { data: { message: `Chapter fetching only supported for Twitch VODs`, vodId, platform: vodRecord.platform } };
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
                  vod_id: vodIdNum,
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
                vod_id: vodIdNum,
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
      } catch (error) {
        const details = extractErrorDetails(error);
        const errorMsg = details.message;
        log.error(`Chapter save failed: ${errorMsg}`);

        internalServerError('Failed to fetch and save chapters');
      }
    }
  );

  // Fetch and save emote metadata for a VOD
  fastify.post<{ Params: RouteParams }>(
    '/:id/vods/:vodId/emotes/save',
    {
      schema: {
        tags: ['Admin'],
        description: 'Fetch and save emote metadata for a VOD',
        params: { type: 'object', properties: { id: { type: 'string' }, vodId: { type: 'string' } }, required: ['id', 'vodId'] },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const tenantId = request.params.id;
      const vodId = request.params.vodId;
      const log = createAutoLogger(tenantId);

      try {
        const config = getTenantConfig(tenantId);

        if (!config) notFound('Tenant not found');

        const client: StreamerDbClient | undefined = getClient(tenantId);

        if (!client) {
          log.error('Database error: Database not available');
          serviceUnavailable('Database not available');
        }

        const vodIdNum = Number(vodId);

        const vodRecord: VodRecord | null = (await client.vod.findUnique({ where: { id: vodIdNum } })) as VodRecord | null;

        if (!vodRecord) notFound(`VOD ${vodId} not found`);

        let channelId: string | undefined;

        // Only supported for Twitch with stream_id available
        if (vodRecord.platform === 'twitch' && vodRecord.stream_id) {
          const twitch = await import('../../../services/twitch');
          const vodData: TwitchVodData = await twitch.getVodData(vodId, tenantId);

          channelId = vodData.user_id;

          if (channelId) {
            log.info(`Fetching emotes for channel ${channelId}`);

            const EmoteModule = await import('../../../services/emotes');
            await EmoteModule.fetchAndSaveEmotes(tenantId, vodIdNum, vodRecord.platform, channelId);

            log.info(`Successfully fetched and saved emotes`);
          } else {
            log.warn(`No channel ID available for Twitch VOD ${vodId}`);
          }
        } else if (vodRecord.platform !== 'twitch') {
          log.info(`Emote fetching only supported for Twitch platform`);
        }

        return { data: { message: `Emote saving completed for ${vodId}`, vodId, platform: vodRecord.platform } };
      } catch (error) {
        const details = extractErrorDetails(error);
        const errorMsg = details.message;
        log.error(`Emote save failed: ${errorMsg}`);

        internalServerError('Failed to queue emote saving job');
      }
    }
  );

  return fastify;
}
