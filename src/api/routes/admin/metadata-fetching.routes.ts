import { FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { getStreamerConfig } from '../../../config/loader';
import createRateLimitMiddleware from '../../middleware/rate-limit';
import adminApiKeyMiddleware from '../../middleware/admin-api-key';

declare module 'fastify' {
  interface FastifyInstance {
    adminRateLimiter: RateLimiterRedis;
  }
}

export default async function metadataFetchingRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: fastify.adminRateLimiter });

  // Fetch and save game chapters from Twitch API (Twitch only)
  fastify.post(
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
    async (request: any) => {
      const streamerId = request.params.id;
      const vodId = request.params.vodId;

      try {
        const config = getStreamerConfig(streamerId);

        if (!config) throw new Error('Tenant not found');

        let client: any;

        try {
          const ClientModule = await import('../../../db/client');
          client = ClientModule.getClient(streamerId);

          if (!client) throw new Error('Database not available');
        } catch (error: any) {
          request.log.error(`[${streamerId}] Database error: ${error.message}`);
          throw new Error('Database not available');
        }

        const vodRecord: any = await client.vod.findUnique({ where: { id: vodId } });

        if (!vodRecord) throw new Error(`VOD ${vodId} not found`);

        // Chapters only supported for Twitch VODs
        if (vodRecord.platform !== 'twitch') {
          return { data: { message: `Chapter fetching only supported for Twitch VODs`, vodId, platform: vodRecord.platform } };
        }

        const durationSeconds = vodRecord.duration ? parseInt(vodRecord.duration.toString()) : 0;

        // Fetch chapters from Twitch API with error handling
        let chaptersData: any | null = null;

        try {
          const twitch = await import('../../../services/twitch');
          chaptersData = await twitch.getChapters(vodId);
        } catch (_err) {
          request.log.warn(`[${vodId}] Failed to fetch chapter data from Twitch API`);
        }

        if (!chaptersData || !chaptersData.video?.previewCardMetadata?.gameClips) {
          return { data: { message: `No chapters found for ${vodId}`, vodId, count: 0 } };
        }

        const gameClips = chaptersData.video.previewCardMetadata.gameClips;
        let savedCount = 0;

        // Handle array format (multiple clips)
        if (Array.isArray(gameClips)) {
          await Promise.all(
            gameClips.map(async (gameClip: any) => {
              try {
                const gameId: string | undefined = gameClip.id ? String(gameClip.id).replace('game_', '') : undefined;
                const chapterName: string | null = gameClip.game?.displayName || null;

                await client.chapter.upsert({
                  where: { id: savedCount },
                  create: {
                    vod_id: vodId,
                    name: chapterName,
                    duration: String(gameClip.duration),
                    start: 0,
                    end: Number(durationSeconds) + gameClip.offsetInSeconds,
                    image: gameClip.game?.color || null,
                    game_id: gameId,
                  },
                  update: {},
                });

                savedCount++;
              } catch (_e) {
                request.log.warn(`[${vodId}] Failed to save chapter`);
              }
            })
          );
        } else if ('game' in gameClips && 'offsetInSeconds' in gameClips) {
          // Handle single object format
          try {
            const gameId: string | undefined = (gameClips as any).id ? String((gameClips as any).id).replace('game_', '') : undefined;
            const singleChapterName: string | null = ((gameClips as any).game?.displayName || null) as string | null;

            await client.chapter.upsert({
              where: { id: savedCount },
              create: {
                vod_id: vodId,
                name: singleChapterName,
                duration: String((gameClips as any).duration),
                start: 0,
                end: Number(durationSeconds) + gameClips.offsetInSeconds,
                image: ((gameClips as any).game?.color || null) as string | undefined,
                game_id: gameId,
              },
              update: {},
            });

            savedCount++;
          } catch (_e) {
            request.log.warn(`[${vodId}] Failed to save chapter`);
          }
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
  fastify.post(
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
    async (request: any) => {
      const streamerId = request.params.id;
      const vodId = request.params.vodId;

      try {
        const config = getStreamerConfig(streamerId);

        if (!config) throw new Error('Tenant not found');

        let client: any;

        try {
          const ClientModule = await import('../../../db/client');
          client = ClientModule.getClient(streamerId);

          if (!client) throw new Error('Database not available');
        } catch (error: any) {
          request.log.error(`[${streamerId}] Database error: ${error.message}`);
          throw new Error('Database not available');
        }

        const vodRecord: any = await client.vod.findUnique({ where: { id: vodId } });

        if (!vodRecord) throw new Error(`VOD ${vodId} not found`);

        let channelId: string | undefined;

        // Only supported for Twitch with stream_id available
        if (vodRecord.platform === 'twitch' && vodRecord.stream_id) {
          const twitch = await import('../../../services/twitch');
          const vodData: any = await twitch.getVodData(vodId, streamerId);

          channelId = vodData.user_id?.toString();

          if (channelId) {
            request.log.info(`[${vodId}] Fetching emotes for channel ${channelId}`);

            const EmoteModule = await import('../../../services/emotes');
            await EmoteModule.fetchAndSaveEmotes(streamerId, vodId, vodRecord.platform as 'twitch' | 'kick', channelId.toString());

            request.log.info(`[${vodId}] Successfully fetched and saved emotes`);
          } else {
            request.warn?.(`[${streamerId}] No channel ID available for Twitch VOD ${vodId}`);
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

  // Get Twitch badges for a channel (global + subscriber) with Redis caching
  fastify.get(
    '/:id/badges/twitch',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Get Twitch badges for a channel (global + subscriber)',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    },
    async (request: any) => {
      const streamerId = request.params.id;

      try {
        const config = getStreamerConfig(streamerId);

        if (!config?.twitch?.id) throw new Error('Twitch not configured for this tenant');

        // Check Redis cache first (60-minute TTL)
        const redisInstance = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

        try {
          const cachedBadges = await redisInstance.get(`twitch_badges:${streamerId}`);

          if (cachedBadges) {
            request.log.info(`[${streamerId}] Returning cached Twitch badges`);

            return { data: JSON.parse(cachedBadges) };
          }
        } catch (_err) {
          // Cache miss or Redis error - continue to fetch from API
        }

        // Fetch from Twitch API on cache miss
        const twitch = await import('../../../services/twitch');

        try {
          const [channelBadges, globalBadges] = await Promise.all([twitch.getChannelBadges(streamerId).catch(() => null), twitch.getGlobalBadges(streamerId).catch(() => null)]);

          const badgesData = { channel: channelBadges || null, global: globalBadges || null };

          // Cache in Redis with 60-minute TTL (3600 seconds) if fetch succeeded
          try {
            await redisInstance.set(`twitch_badges:${streamerId}`, JSON.stringify(badgesData), 'EX', 3600);

            request.log.info(`[${streamerId}] Fetched and cached Twitch badges`);

            return { data: badgesData };
          } catch (_cacheError) {
            // Cache write failure - still return the fetched data even if caching fails
            request.warn?.(`Failed to cache Twitch badges in Redis, returning uncached result for ${streamerId}`);

            return { data: badgesData };
          }
        } finally {
          await redisInstance.quit().catch(() => {}); // Graceful disconnect - ignore errors
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        request.log.error(`[${streamerId}] Failed to fetch Twitch badges: ${errorMsg}`);

        throw new Error('Something went wrong trying to retrieve channel badges..');
      }
    }
  );

  return fastify;
}
