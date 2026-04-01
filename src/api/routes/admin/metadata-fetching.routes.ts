import type { FastifyInstance } from 'fastify';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import dayjs from 'dayjs';
import durationPlugin from 'dayjs/plugin/duration';
import { getStreamerConfig } from '../../../config/loader';
import createRateLimitMiddleware from '../../middleware/rate-limit';
import adminApiKeyMiddleware from '../../middleware/admin-api-key';
import { getClient } from '../../../db/client.js';
import type { VodData as TwitchVodData } from '../../../services/twitch.js';

dayjs.extend(durationPlugin);

declare module 'fastify' {
  interface FastifyInstance {
    adminRateLimiter: RateLimiterRedis;
  }
}

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
  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: fastify.adminRateLimiter });

  // Fetch and save game chapters from Twitch API (Twitch only)
  fastify.post<{ Params: RouteParams }>(
    '/:id/vods/:vodId/chapters/save',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Fetch and save game chapters from Twitch API (Twitch only)',
        params: { type: 'object', properties: { id: { type: 'string' }, vodId: { type: 'string' } }, required: ['id', 'vodId'] },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const streamerId = request.params.id;
      const vodId = request.params.vodId;

      try {
        const config = getStreamerConfig(streamerId);

        if (!config) throw new Error('Tenant not found');

        const client: StreamerDbClient | undefined = getClient(streamerId);

        if (!client) {
          request.log.error(`[${streamerId}] Database error: Database not available`);
          throw new Error('Database not available');
        }

        const vodRecord: VodRecord | null = (await client.vod.findUnique({ where: { id: vodId } })) as VodRecord | null;

        if (!vodRecord) throw new Error(`VOD ${vodId} not found`);

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
        } catch (_err) {
          request.log.warn(`[${vodId}] Failed to fetch chapter data from Twitch API`);
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
                  const gameData = await twitch.getGameData(gameNode.id, streamerId);
                  if (gameData && 'box_art_url' in gameData) {
                    image = String(gameData.box_art_url).replace('{width}x{height}', '40x53');
                  }
                }
              } catch (_err2) {
                request.log.warn(`[${vodId}] Failed to fetch game data`);
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
                  vod_id: vodId,
                  name: gameNode.displayName || null,
                  duration: durationFormatted,
                  start: startSeconds,
                  end: endSeconds,
                  image,
                  game_id: gameNode.id ? String(gameNode.id) : undefined,
                },
              });

              savedCount++;
            } catch (_e) {
              request.log.warn(`[${vodId}] Failed to save chapter`);
            }
          }
        } else {
          // Single chapter case - use getChapter fallback
          let chapterData: Record<string, unknown> | null = null;

          try {
            const twitch = await import('../../../services/twitch');
            chapterData = await twitch.getChapter(vodId);
          } catch (_err) {
            request.log.warn(`[${vodId}] Failed to fetch single chapter data from Twitch API`);
          }

          if (chapterData && 'game' in chapterData) {
            const gameNode = chapterData.game as ChapterGame;
            let image: string | null = null;

            try {
              const twitch = await import('../../../services/twitch');
              if (gameNode.id) {
                const gameData = await twitch.getGameData(gameNode.id, streamerId);
                if (gameData && 'box_art_url' in gameData) {
                  image = String(gameData.box_art_url).replace('{width}x{height}', '40x53');
                }
              }
            } catch (_err2) {
              request.log.warn(`[${vodId}] Failed to fetch game data`);
            }

            await client.chapter.create({
              data: {
                vod_id: vodId,
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
        const errorMsg = error instanceof Error ? error.message : String(error);
        request.log.error(`[${streamerId}] Chapter save failed: ${errorMsg}`);

        throw new Error('Failed to fetch and save chapters');
      }
    }
  );

  // Fetch and save emote metadata for a VOD
  fastify.post<{ Params: RouteParams }>(
    '/:id/vods/:vodId/emotes/save',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Fetch and save emote metadata for a VOD',
        params: { type: 'object', properties: { id: { type: 'string' }, vodId: { type: 'string' } }, required: ['id', 'vodId'] },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const streamerId = request.params.id;
      const vodId = request.params.vodId;

      try {
        const config = getStreamerConfig(streamerId);

        if (!config) throw new Error('Tenant not found');

        const client: StreamerDbClient | undefined = getClient(streamerId);

        if (!client) {
          request.log.error(`[${streamerId}] Database error: Database not available`);
          throw new Error('Database not available');
        }

        const vodRecord: VodRecord | null = (await client.vod.findUnique({ where: { id: vodId } })) as VodRecord | null;

        if (!vodRecord) throw new Error(`VOD ${vodId} not found`);

        let channelId: string | undefined;

        // Only supported for Twitch with stream_id available
        if (vodRecord.platform === 'twitch' && vodRecord.stream_id) {
          const twitch = await import('../../../services/twitch');
          const vodData: TwitchVodData = await twitch.getVodData(vodId, streamerId);

          channelId = vodData.user_id;

          if (channelId) {
            request.log.info(`[${vodId}] Fetching emotes for channel ${channelId}`);

            const EmoteModule = await import('../../../services/emotes');
            await EmoteModule.fetchAndSaveEmotes(streamerId, vodId, vodRecord.platform, channelId);

            request.log.info(`[${vodId}] Successfully fetched and saved emotes`);
          } else {
            request.log.warn(`[${streamerId}] No channel ID available for Twitch VOD ${vodId}`);
          }
        } else if (vodRecord.platform !== 'twitch') {
          request.log.info(`[${vodId}] Emote fetching only supported for Twitch platform`);
        }

        return { data: { message: `Emote saving completed for ${vodId}`, vodId, platform: vodRecord.platform } };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        request.log.error(`[${streamerId}] Emote save failed: ${errorMsg}`);

        throw new Error('Failed to queue emote saving job');
      }
    }
  );

  return fastify;
}
