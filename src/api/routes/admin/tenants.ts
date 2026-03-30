import { FastifyInstance } from 'fastify';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import Redis from 'ioredis';
import fsPromises from 'fs/promises';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { getTenantStats, getAllTenants } from '../../../services/tenants.service.js';
import { getClient } from '../../../db/client.js';
import { getStreamerConfig } from '../../../config/loader.js';
import createRateLimitMiddleware from '../../middleware/rate-limit.js';
import adminApiKeyMiddleware from '../../middleware/admin-api-key.js';
import { getYoutubeUploadQueue, getVODDownloadQueue, getChatDownloadQueue, getDmcaProcessingQueue } from '../../../jobs/queues.js';

dayjs.extend(utc);
dayjs.extend(timezone);

type TenantsRoutesOptions = Record<string, unknown>;

declare module 'fastify' {
  interface FastifyInstance {
    adminRateLimiter: RateLimiterRedis;
  }
}

export default async function tenantsRoutes(fastify: FastifyInstance, _options: TenantsRoutesOptions) {
  const rateLimitMiddleware = createRateLimitMiddleware({
    limiter: fastify.adminRateLimiter,
  });

  fastify.get(
    '/',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'List all tenants (streamers)',
        security: [{ apiKey: [] }],
        headers: {
          type: 'object',
          properties: {
            Authorization: {
              type: 'string',
              description: 'Bearer token with API key (e.g., "Bearer archive_...")',
            },
            'X-API-Key': {
              type: 'string',
              description: 'Direct API key header as alternative to Bearer auth',
            },
          },
        },
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async () => {
      const tenants = await getAllTenants();
      return { data: tenants };
    }
  );

  fastify.get(
    '/:id/stats',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Get detailed stats for a tenant',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Tenant ID' },
          },
          required: ['id'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const { id } = request.params as { id: string };

      const config = getStreamerConfig(id);
      if (!config) {
        throw new Error('Tenant not found');
      }

      const client = getClient(id);
      if (!client) {
        throw new Error('Database not available');
      }

      const stats = await getTenantStats(client, id);
      return { data: stats };
    }
  );

  fastify.post(
    '/:id/download',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Create VOD record if missing, then queue download + emote + chat jobs (Twitch/Kick)',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            vodId: { type: 'string' },
            type: { type: 'string', enum: ['live', 'vod'] },
            platform: { type: 'string', enum: ['twitch', 'kick'] },
            path: { type: 'string' },
          },
          required: ['vodId', 'type', 'platform'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as any;

      try {
        const config = getStreamerConfig(id);
        if (!config) throw new Error('Tenant not found');

        if (body.platform === 'twitch' && !config.twitch?.enabled) {
          throw new Error('Twitch is not enabled for this tenant');
        }
        if (body.platform === 'kick' && !config.kick?.enabled) {
          throw new Error('Kick is not enabled for this tenant');
        }

        const client = getClient(id);
        if (!client) throw new Error('Database not available');

        let vodRecord: any;
        try {
          vodRecord = await (client as any).vod.findUnique({ where: { id: body.vodId } });
        } catch {
          vodRecord = null;
        }

        if (!vodRecord) {
          // Create VOD record by fetching metadata from platform API
          request.log.info(`[${id}] Creating new VOD ${body.vodId} for platform ${body.platform}`);

          let vodMetadata: any;

          if (body.platform === 'twitch') {
            const twitch = await import('../../../services/twitch.js');
            vodMetadata = await twitch.getVodData(body.vodId, id);

            // Validate ownership
            if (!config.twitch?.id || vodMetadata.user_id !== config.twitch.id) {
              throw new Error('This VOD belongs to another Twitch channel');
            }

            const durationParts: any[] = vodMetadata.duration.replace('PT', '').split(/[HMS]/);
            let totalSeconds = 0;
            if (durationParts.length >= 3 && !isNaN(durationParts[1])) {
              totalSeconds += parseInt(durationParts[0] || '0') * 3600 + parseInt(durationParts[1]) * 60 + parseInt(durationParts[2]);
            }

            vodRecord = await (client as any).vod.create({
              data: {
                id: body.vodId,
                title: vodMetadata.title || null,
                created_at: new Date(vodMetadata.started_at),
                duration: totalSeconds,
                stream_id: vodMetadata.stream_id || null,
                platform: 'twitch',
              },
            });

            request.log.info(`[${id}] Created Twitch VOD ${body.vodId} with user_id=${vodMetadata.user_id}`);
          } else if (body.platform === 'kick') {
            const kick = await import('../../../services/kick.js');

            if (!config.kick?.username) {
              throw new Error('Kick username not configured for this tenant');
            }

            vodMetadata = await kick.getVod(config.kick.username, body.vodId);

            // Trust URL path for ownership validation - if fetch succeeds, it belongs to that channel
            request.log.info(`[${id}] Fetched Kick VOD ${body.vodId} from channel ${config.kick.username}`);

            vodRecord = await (client as any).vod.create({
              data: {
                id: body.vodId.toString(),
                title: vodMetadata.title || null,
                created_at: new Date(vodMetadata.created_at),
                duration: Math.floor(Number(vodMetadata.duration) / 1000), // Convert ms to seconds
                stream_id: vodRecord?.stream_id ?? `${vodMetadata.id}`,
                platform: 'kick',
              },
            });

            request.log.info(`[${id}] Created Kick VOD ${body.vodId} with duration=${Number(vodMetadata.duration)}ms`);
          } else {
            throw new Error('Unsupported platform');
          }
        } else {
          // Validate existing record matches requested platform
          if (vodRecord.platform !== body.platform) {
            request.log.warn(`[${id}] VOD ${body.vodId} exists but has different platform: expected=${body.platform}, actual=${vodRecord.platform}`);
          }

          request.log.info(`[${id}] Using existing VOD record for ${body.vodId}`);
        }

        // Queue emote save job (fire-and-forget within request context)
        const channelId = body.platform === 'twitch' && vodRecord.stream_id ? String(vodRecord.stream_id) : undefined;

        if (channelId) {
          import('../../../services/emotes.js')
            .then(({ fetchAndSaveEmotes }) =>
              fetchAndSaveEmotes(id, body.vodId, body.platform as 'twitch' | 'kick', channelId).catch((err) => {
                request.log.error(`[${body.vodId}] Emote save failed: ${err.message}`);
              })
            )
            .catch((err) => {
              request.log.error(`[${body.vodId}] Failed to load emotes module: ${err.message}`);
            });

          request.log.info(`[${id}] Queued async emote fetch for ${body.vodId} (channel=${channelId})`);
        } else {
          request.log.warn(`[${id}] No channel ID available for emote fetching on VOD ${body.vodId}`);
        }

        // Queue VOD download job
        const vodDownloadJob = { streamerId: id, vodId: body.vodId, platform: body.platform as 'twitch' | 'kick', userId: id };
        await (getVODDownloadQueue() as any).add(vodDownloadJob, { name: 'vod_download', id: `download:${body.vodId}:${Date.now()}` });
        const vodJobId = `download:${body.vodId}:${Date.now()}`;

        // Queue chat download job
        let durationSeconds = 0;
        if (typeof vodRecord.duration === 'number') {
          durationSeconds = Number(vodRecord.duration);
        } else if (vodRecord.platform === 'twitch' && typeof vodRecord.duration === 'string') {
          const [hrs, mins, secs] = vodRecord.duration.split(':').map(Number);
          durationSeconds = hrs * 3600 + mins * 60 + secs;
        }

        await (getChatDownloadQueue() as any).add(
          { streamerId: id, vodId: body.vodId, platform: body.platform as 'twitch' | 'kick', duration: durationSeconds },
          { name: 'chat_download', id: `chat:${body.vodId}:${Date.now()}` }
        );
        const chatJobId = `chat:${body.vodId}:${Date.now()}`;

        request.log.info(`[${id}] Queued download jobs for ${body.vodId}: vod=${vodJobId}, chat=${chatJobId}`);

        return { data: { message: 'Download jobs queued', vodId: body.vodId, jobId: vodJobId, chatJobId } };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        request.log.error(`[${id}] Download failed: ${errorMsg}`);
        throw new Error('Failed to queue download jobs');
      }
    }
  );

  fastify.post(
    '/:id/games/add',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Manually create a Game clip record with required YouTube video_id field',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            vod_id: { type: 'string' },
            start_time: { type: 'number' },
            end_time: { type: 'number' },
            video_provider: { type: 'string' },
            video_id: { type: 'string' },
            game_id: { type: 'string' },
            game_name: { type: 'string' },
            thumbnail_url: { type: 'string' },
          },
          required: ['vod_id', 'start_time', 'end_time', 'video_provider', 'video_id', 'game_id', 'game_name'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as any;

      try {
        const client = getClient(id);
        if (!client) throw new Error('Database not available');

        // Validate VOD exists first
        const vodRecord: any = await (client as any).vod.findUnique({ where: { id: body.vod_id } });
        if (!vodRecord) {
          throw new Error(`${body.vod_id} does not exist!`);
        }

        // Create Game record with all fields mapped to schema columns
        const newGame = await (client as any).game.create({
          data: {
            vod_id: body.vod_id,
            start_time: Number(body.start_time),
            end_time: body.end_time ? Number(body.end_time) : null,
            video_provider: body.video_provider || 'youtube',
            video_id: body.video_id,
            game_id: body.game_id || null,
            game_name: body.game_name,
            thumbnail_url: body.thumbnail_url || null,
          },
        });

        // If YouTube provider and video_id provided (always required per design), also create VodUpload relation
        if (body.video_provider === 'youtube' && body.video_id) {
          await (client as any).vodUpload.create({
            data: { vod_id: body.vod_id, upload_id: body.video_id, platform: 'youtube', type: 'game', status: 'COMPLETED' },
          });

          request.log.info(`[${id}] Created VodUpload relation for game ${newGame.id} with video_id=${body.video_id}`);
        }

        return { data: { message: `Created ${body.game_name} in games DB for ${body.vod_id}`, gameId: newGame.id, vodId: body.vod_id } };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);

        request.log.error(`[${id}] Download failed: ${errorMsg}`);

        throw new Error('Failed to queue download jobs');
      }
    }
  );

  fastify.post(
    '/:id/vods/:vodId/save-duration',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Fetch fresh duration from platform API and update existing VOD only (NOT a create endpoint)',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            vodId: { type: 'string' },
          },
          required: ['id', 'vodId'],
        },
        body: {
          type: 'object',
          properties: {
            platform: { type: 'string', enum: ['twitch', 'kick'] },
          },
          required: ['platform'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const { id, vodId } = request.params as { id: string; vodId: string };
      const body = request.body as any;

      try {
        const client = getClient(id);
        if (!client) throw new Error('Database not available');

        // This is NOT a create endpoint - VOD must already exist
        const existingVod: any = await (client as any).vod.findUnique({ where: { id: vodId } });
        if (!existingVod) {
          throw new Error(`VOD ${vodId} does not exist!`);
        }

        // Fetch fresh metadata from platform API based on body.platform param
        let newDurationSeconds = 0;

        if (body.platform === 'twitch') {
          const twitch = await import('../../../services/twitch.js');
          const vodMetadata: any = await twitch.getVodData(vodId, id);

          // Parse Twitch ISO duration format "PT2H3M15S" to seconds
          let durStr = String(vodMetadata.duration).replace('PT', '');
          let hours = 0;
          let minutes = 0;
          let secs = 0;

          if (durStr.includes('H')) {
            [hours] = durStr.split('H').map(Number);
            durStr = durStr.replace(`${Math.floor(hours)}H`, '');
          }
          if (durStr.includes('M')) {
            const mParts = durStr.split('M');
            minutes = parseInt(mParts[0]);
            secs = parseFloat(mParts[1].replace('S', ''));
          } else if (durStr.endsWith('S')) {
            secs = parseFloat(durStr.replace('S', ''));
          }

          newDurationSeconds = hours * 3600 + minutes * 60 + Math.floor(secs);

          request.log.info(`[${id}] Fetched Twitch duration for ${vodId}: PT${hours}H${minutes}M${secs}S => ${newDurationSeconds}s`);
        } else if (body.platform === 'kick') {
          const kick = await import('../../../services/kick.js');
          const config = getStreamerConfig(id)!;

          // Trust URL path for ownership - fetch from configured channel
          const vodMetadata: any = await kick.getVod(config.kick!.username!, vodId);

          // Kick returns duration in milliseconds, convert to seconds
          newDurationSeconds = Math.floor(Number(vodMetadata.duration) / 1000);

          request.log.info(`[${id}] Fetched Kick duration for ${vodId}: ${Number(vodMetadata.duration)}ms => ${newDurationSeconds}s`);
        } else {
          throw new Error('Unsupported platform');
        }

        // Update ONLY the duration field, leave all other fields untouched
        await (client as any).vod.update({ where: { id: vodId }, data: { duration: newDurationSeconds } });

        return { data: { message: 'Saved duration!', vodId, oldDuration: existingVod.duration, newDuration: newDurationSeconds } };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        request.log.error(`[${id}] Duration save failed for ${vodId}: ${errorMsg}`);
        throw new Error('Failed to update duration');
      }
    }
  );

  fastify.post(
    '/:id/hlsDownload',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Convenience endpoint - trigger VOD + chat download together (Twitch/Kick with optional platform param)',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            vodId: { type: 'string' },
            platform: { type: 'string', enum: ['twitch', 'kick'] },
          },
          required: ['vodId'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as any;

      try {
        // Default to Twitch for backward compatibility if platform not specified
        const platform = body.platform || 'twitch';

        const config = getStreamerConfig(id);
        if (!config) throw new Error('Tenant not found');

        if (platform === 'twitch' && !config.twitch?.enabled) {
          throw new Error('Twitch is not enabled for this tenant');
        }
        if (platform === 'kick' && !config.kick?.enabled) {
          throw new Error('Kick is not enabled for this tenant');
        }

        const client = getClient(id);
        if (!client) throw new Error('Database not available');

        // Check if VOD exists, create it via platform API fetch if missing
        let vodRecord: any;
        try {
          vodRecord = await (client as any).vod.findUnique({ where: { id: body.vodId } });
        } catch {
          vodRecord = null;
        }

        if (!vodRecord) {
          // Create VOD record by fetching metadata from platform API
          request.log.info(`[${id}] Creating new VOD ${body.vodId} for hlsDownload (platform=${platform})`);

          let vodMetadata: any;

          if (platform === 'twitch') {
            const twitch = await import('../../../services/twitch.js');
            vodMetadata = await twitch.getVodData(body.vodId, id);

            // Validate ownership
            if (!config.twitch?.id || vodMetadata.user_id !== config.twitch.id) {
              throw new Error('This VOD belongs to another Twitch channel');
            }

            const durationParts: any[] = vodMetadata.duration.replace('PT', '').split(/[HMS]/);
            let totalSeconds = 0;
            if (durationParts.length >= 3 && !isNaN(durationParts[1])) {
              totalSeconds += parseInt(durationParts[0] || '0') * 3600 + parseInt(durationParts[1]) * 60 + parseInt(durationParts[2]);
            }

            vodRecord = await (client as any).vod.create({
              data: {
                id: body.vodId,
                title: vodMetadata.title || null,
                created_at: new Date(vodMetadata.started_at),
                duration: totalSeconds,
                stream_id: vodMetadata.stream_id || null,
                platform: 'twitch',
              },
            });
          } else if (platform === 'kick') {
            const kick = await import('../../../services/kick.js');

            if (!config.kick?.username) {
              throw new Error('Kick username not configured for this tenant');
            }

            vodMetadata = await kick.getVod(config.kick.username, body.vodId);

            // Trust URL path for ownership validation
            request.log.info(`[${id}] Fetched Kick VOD ${body.vodId} from channel ${config.kick.username}`);

            vodRecord = await (client as any).vod.create({
              data: {
                id: String(body.vodId),
                title: vodMetadata.title || null,
                created_at: new Date(vodMetadata.created_at),
                duration: Math.floor(Number(vodMetadata.duration) / 1000),
                stream_id: `${vodMetadata.id}`,
                platform: 'kick',
              },
            });
          } else {
            throw new Error('Unsupported platform');
          }

          request.log.info(`[${id}] Created VOD ${body.vodId} for platform ${platform}`);
        } else if (vodRecord.platform !== platform) {
          // Warn but continue - existing record has different platform than requested
          request.log.warn(`[${id}] Existing VOD ${body.vodId} has mismatched platform: expected=${platform}, actual=${vodRecord.platform}`);
        }

        // Queue emote save (fire-and-forget)
        const channelId = vodRecord.stream_id ? String(vodRecord.stream_id) : undefined;

        if (channelId && !body.skipEmotes) {
          import('../../../services/emotes.js')
            .then(({ fetchAndSaveEmotes }) =>
              fetchAndSaveEmotes(id, body.vodId, platform as 'twitch' | 'kick', channelId).catch((err) => {
                request.log.error(`[${body.vodId}] Emote save failed: ${err.message}`);
              })
            )
            .catch((err) => {
              request.log.error(`[${body.vodId}] Failed to load emotes module: ${err.message}`);
            });

          request.log.info(`[${id}] Queued async emote fetch for hlsDownload VOD ${body.vodId} (channel=${channelId})`);
        }

        // Queue VOD download job
        const vodDownloadJob = { streamerId: id, vodId: body.vodId, platform: platform as 'twitch' | 'kick', userId: id };
        await (getVODDownloadQueue() as any).add(vodDownloadJob, { name: 'vod_download', id: `hls:${body.vodId}:${Date.now()}` });

        // Queue chat download job
        let durationSeconds = 0;
        if (typeof vodRecord.duration === 'number') {
          durationSeconds = Number(vodRecord.duration);
        } else if (vodRecord.platform === 'twitch' && typeof vodRecord.duration === 'string') {
          const [hrs, mins, secs] = String(vodRecord.duration).split(':').map(Number);
          durationSeconds = hrs * 3600 + mins * 60 + secs;
        }

        await (getChatDownloadQueue() as any).add(
          { streamerId: id, vodId: body.vodId, platform: platform as 'twitch' | 'kick', duration: durationSeconds },
          { name: 'chat_download', id: `hls-chat:${body.vodId}:${Date.now()}` }
        );

        request.log.info(`[${id}] Queued HLS download jobs for ${body.vodId} (platform=${platform})`);

        return { data: { message: 'HLS download jobs queued', vodId: body.vodId, platform, jobId: `hls:${body.vodId}:${Date.now()}` } };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        request.log.error(`[${id}] HLS download failed for ${body.vodId}: ${errorMsg}`);
        throw new Error('Failed to queue HLS download jobs');
      }
    }
  );

  fastify.post(
    '/:id/vods/:vodId/re-upload-youtube',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Manually trigger YouTube re-upload for a VOD with duration validation',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            vodId: { type: 'string' },
          },
          required: ['id', 'vodId'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const { id, vodId } = request.params as { id: string; vodId: string };

      try {
        const config = getStreamerConfig(id);
        if (!config) throw new Error('Tenant not found');
        if (!config.youtube) throw new Error('YouTube integration not configured for this tenant');

        const client = getClient(id);
        if (!client) throw new Error('Database not available');

        const vodRecord: any = await (client as any).vod.findUnique({ where: { id: vodId } });
        if (!vodRecord) throw new Error(`VOD ${vodId} not found`);

        const finalMp4Path = `${config.settings.vodPath}/${id}/${vodId}.mp4`;

        await fsPromises.access(finalMp4Path).catch(() => {
          throw new Error('MP4 file not found. VOD may not have been processed yet.');
        });

        const { validateVideoDuration, compareDurations } = await import('../../../utils/video-validator.js');
        const actualDuration: number | null = await validateVideoDuration(finalMp4Path);

        if (!actualDuration) throw new Error('Could not determine video duration from MP4 file');

        let expectedSeconds: number | null = null;
        let comparisonResult: any = null;

        const durationStr = vodRecord.duration as string;

        if (vodRecord.platform === 'twitch' && typeof durationStr === 'string') {
          const [hrs, mins, secs] = durationStr.split(':').map(Number);
          expectedSeconds = hrs * 3600 + mins * 60 + secs;

          if (expectedSeconds > 0) {
            comparisonResult = await compareDurations(actualDuration, expectedSeconds);
            fastify.log.info(`[${vodId}] Duration validation: actual=${actualDuration}s vs expected=${expectedSeconds}s (${comparisonResult.diffPercent}% diff)`);

            if (!comparisonResult.valid && comparisonResult.diffPercent > 15) {
              request.log.warn(`Large duration mismatch detected for ${vodId}: ${comparisonResult.diffPercent}%`);
            } else {
              fastify.log.info(`[${vodId}] Duration validation: actual=${actualDuration}s (no expected duration to compare)`);
            }
          }

          const youtubeJob = {
            streamerId: id,
            vodId,
            filePath: finalMp4Path,
            title: `Re-upload: ${vodRecord.title || vodId}`,
            description: 'Manual re-upload triggered via admin endpoint',
            type: 'vod' as const,
          };

          await (getYoutubeUploadQueue() as any).add(youtubeJob, { id: `youtube-reupload:${vodId}:${Date.now()}` });

          return { data: { message: 'YouTube re-upload job queued', vodId, jobId: `youtube-reupload:${vodId}:${Date.now()}`, durationValidation: expectedSeconds ? comparisonResult : null } };
        } else {
          const youtubeJob = {
            streamerId: id,
            vodId,
            filePath: finalMp4Path,
            title: `Re-upload: ${vodRecord.title || vodId}`,
            description: 'Manual re-upload triggered via admin endpoint',
            type: 'vod' as const,
          };

          await (getYoutubeUploadQueue() as any).add(youtubeJob, { id: `youtube-reupload:${vodId}:${Date.now()}` });
          return { data: { message: 'YouTube re-upload job queued', vodId, jobId: `youtube-reupload:${vodId}:${Date.now()}`, durationValidation: null } };
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        request.log.error(`[${vodId}] Re-upload failed: ${errorMsg}`);
        throw new Error('Failed to queue re-upload job');
      }
    }
  );

  fastify.post(
    '/:id/vods/:vodId/re-download',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Manually trigger VOD download (clears Redis dedup key first)',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            vodId: { type: 'string' },
          },
          required: ['id', 'vodId'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const { id, vodId } = request.params as { id: string; vodId: string };

      try {
        const config = getStreamerConfig(id);
        if (!config) throw new Error('Tenant not found');

        const client = getClient(id);
        if (!client) throw new Error('Database not available');

        const vodRecord: any = await (client as any).vod.findUnique({ where: { id: vodId } });
        if (!vodRecord) throw new Error(`VOD ${vodId} not found`);

        const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

        try {
          await redis.del(`vod_download:${vodId}`);
          request.log.info(`[${vodId}] Cleared Redis dedup key for manual re-download`);
        } catch (err) {
          const errStr = err instanceof Error ? err.message : String(err);
          request.log.warn(`Failed to clear dedup key: ${errStr}`);
        }

        const downloadJob = {
          streamerId: id,
          vodId,
          platform: vodRecord.platform as 'twitch' | 'kick',
          userId: id,
        };

        await (getVODDownloadQueue() as any).add(downloadJob, { name: 'vod_download', id: `download:${vodId}:${Date.now()}` });

        return { data: { message: 'Re-download job queued', vodId, jobId: `download:${vodId}:${Date.now()}` } };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        request.log.error(`[${vodId}] Re-download failed: ${errorMsg}`);
        throw new Error('Failed to queue re-download job');
      }
    }
  );

  fastify.post(
    '/:id/vods/:vodId/chat/regenerate',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Regenerate chat logs for a VOD with resume support',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            vodId: { type: 'string' },
          },
          required: ['id', 'vodId'],
        },
        querystring: {
          type: 'object',
          properties: {
            force: { type: 'boolean', description: 'Force regeneration even if logs exist' },
          },
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const { id, vodId } = request.params as { id: string; vodId: string };
      const force = (request.query as any).force === true || (request.query as any).force === 'true';

      try {
        const config = getStreamerConfig(id);
        if (!config) throw new Error('Tenant not found');

        const client = getClient(id);
        if (!client) throw new Error('Database not available');

        const vodRecord: any = await (client as any).vod.findUnique({ where: { id: vodId } });
        if (!vodRecord) throw new Error(`VOD ${vodId} not found`);

        const existingCount = await (client as any).chatMessage.count({ where: { vod_id: vodId } });

        if (existingCount > 0 && !force) {
          return { data: { message: `Logs already exist for ${vodId}. Use force=true to overwrite.`, vodId, existingCount } };
        }

        let startOffset = 0;
        if (!force && existingCount > 0) {
          const lastMessage: any = await (client as any).chatMessage.findFirst({ where: { vod_id: vodId }, orderBy: { content_offset_seconds: 'desc' } });
          if (lastMessage?.content_offset_seconds !== undefined && Number(lastMessage.content_offset_seconds) > 0) {
            startOffset = Math.floor(Number(lastMessage.content_offset_seconds));
            request.log.info(`[${vodId}] Resuming chat download from offset ${startOffset}s`);
          }
        }

        if (!force && existingCount > 0) {
          await (client as any).chatMessage.deleteMany({ where: { vod_id: vodId } });
        }

        const durationSeconds = vodRecord.duration ? parseInt(vodRecord.duration.toString()) : 0;

        await (getChatDownloadQueue() as any).add(
          { streamerId: id, vodId, platform: vodRecord.platform as 'twitch' | 'kick', duration: durationSeconds, startOffset },
          { name: 'chat_download', id: `chat:${vodId}:${Date.now()}` }
        );

        return {
          data: {
            message: force ? 'Chat regeneration job queued (force mode)' : 'Chat download job queued with resume support',
            vodId,
            jobId: `chat:${vodId}:${Date.now()}`,
            startOffset,
            durationSeconds,
          },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        request.log.error(`[${vodId}] Chat regeneration failed: ${errorMsg}`);
        throw new Error('Failed to queue chat regeneration job');
      }
    }
  );

  fastify.post(
    '/:id/vods/:vodId/emotes/save',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Fetch and save emote metadata for a VOD',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            vodId: { type: 'string' },
          },
          required: ['id', 'vodId'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const { id, vodId } = request.params as { id: string; vodId: string };

      try {
        const config = getStreamerConfig(id);
        if (!config) throw new Error('Tenant not found');

        const client = getClient(id);
        if (!client) throw new Error('Database not available');

        const vodRecord: any = await (client as any).vod.findUnique({ where: { id: vodId } });
        if (!vodRecord) throw new Error(`VOD ${vodId} not found`);

        let channelId;
        if (vodRecord.platform === 'twitch' && vodRecord.stream_id) {
          const twitch = await import('../../../services/twitch.js');
          const vodData: any = await twitch.getVodData(vodId, id);
          channelId = vodData.user_id?.toString();
        }

        if (channelId) {
          request.log.info(`[${vodId}] Fetching emotes for channel ${channelId}`);
          const { fetchAndSaveEmotes } = await import('../../../services/emotes.js');
          await fetchAndSaveEmotes(id, vodId, vodRecord.platform as 'twitch' | 'kick', channelId.toString());
        }

        return { data: { message: `Emote saving queued for ${vodId}`, vodId, platform: vodRecord.platform } };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        request.log.error(`[${vodId}] Emote save failed: ${errorMsg}`);
        throw new Error('Failed to queue emote saving job');
      }
    }
  );

  fastify.post(
    '/:id/vods/create',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Create a VOD record manually (without drive field)',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            vodId: { type: 'string' },
            title: { type: 'string' },
            createdAt: { type: 'string' },
            duration: { type: 'number' },
            platform: { type: 'string', enum: ['twitch', 'kick'] },
          },
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as any;

      try {
        const config = getStreamerConfig(id);
        if (!config) throw new Error('Tenant not found');

        const client = getClient(id);
        if (!client) throw new Error('Database not available');

        const existing: any = await (client as any).vod.findUnique({ where: { id: body.vodId } });
        if (existing) {
          return { data: { message: `${body.vodId} already exists!`, vodId: body.vodId } };
        }

        const newVod = await (client as any).vod.create({
          data: {
            id: body.vodId,
            title: body.title || null,
            created_at: body.createdAt ? new Date(body.createdAt) : undefined,
            duration: Number(body.duration) || 0,
            platform: body.platform || 'twitch',
          },
        });

        request.log.info(`[${id}] Created VOD ${body.vodId}`);
        return { data: { message: `${newVod.id} created!`, vodId: newVod.id } };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        request.log.error(`[${id}] VOD creation failed: ${errorMsg}`);
        throw new Error('Failed to create VOD record');
      }
    }
  );

  fastify.delete(
    '/:id/vods/:vodId/delete',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Delete a VOD and all related data (chapters, games, uploads)',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            vodId: { type: 'string' },
          },
          required: ['id', 'vodId'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const { id, vodId } = request.params as { id: string; vodId: string };

      try {
        const client = getClient(id);
        if (!client) throw new Error('Database not available');

        await (client as any).chatMessage.deleteMany({ where: { vod_id: vodId } });
        await (client as any).vod.deleteMany({ where: { id: vodId } });

        request.log.info(`[${id}] Deleted VOD ${vodId} and related data`);
        return { data: { message: `Deleted VOD ${vodId}`, vodId } };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        request.log.error(`[${id}] VOD deletion failed: ${errorMsg}`);
        throw new Error('Failed to delete VOD record');
      }
    }
  );

  fastify.post(
    '/:id/vods/:vodId/chapters/save',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Fetch and save game chapters from Twitch API (Twitch only)',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            vodId: { type: 'string' },
          },
          required: ['id', 'vodId'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const { id, vodId } = request.params as { id: string; vodId: string };

      try {
        const config = getStreamerConfig(id);
        if (!config) throw new Error('Tenant not found');

        const client = getClient(id);
        if (!client) throw new Error('Database not available');

        const vodRecord: any = await (client as any).vod.findUnique({ where: { id: vodId } });
        if (!vodRecord) throw new Error(`VOD ${vodId} not found`);

        if (vodRecord.platform !== 'twitch') {
          return { data: { message: `Chapter fetching only supported for Twitch VODs`, vodId, platform: vodRecord.platform } };
        }

        const durationSeconds = vodRecord.duration ? parseInt(vodRecord.duration.toString()) : 0;

        let chaptersData: any | null = null;
        try {
          const twitch = await import('../../../services/twitch.js');
          chaptersData = await twitch.getChapters(vodId);
        } catch (err) {
          request.log.warn(`[${vodId}] Failed to fetch chapter data from Twitch API`);
        }

        if (!chaptersData || !chaptersData.video?.previewCardMetadata?.gameClips) {
          return { data: { message: `No chapters found for ${vodId}`, vodId, count: 0 } };
        }

        const gameClips = chaptersData.video.previewCardMetadata.gameClips;
        let savedCount = 0;

        if (Array.isArray(gameClips)) {
          await Promise.all(
            gameClips.map(async (gameClip) => {
              try {
                const gameId: string | undefined = gameClip.id ? String(gameClip.id).replace('game_', '') : undefined;
                const chapterName: string | null = gameClip.game?.displayName || null;

                await (client as any).chapter.upsert({
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
              } catch (e) {
                request.log.warn(`[${vodId}] Failed to save chapter`);
              }
            })
          );
        } else if ('game' in gameClips && 'offsetInSeconds' in gameClips) {
          try {
            const gameId: string | undefined = (gameClips as any).id ? String((gameClips as any).id).replace('game_', '') : undefined;
            const singleChapterName: string | null = ((gameClips as any).game?.displayName || null) as string | null;

            await (client as any).chapter.upsert({
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
          } catch (e) {
            request.log.warn(`[${vodId}] Failed to save chapter`);
          }
        }

        return { data: { message: `Saved chapters for ${vodId}`, vodId, count: savedCount } };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        request.log.error(`[${id}] Chapter save failed: ${errorMsg}`);
        throw new Error('Failed to fetch and save chapters');
      }
    }
  );

  fastify.post(
    '/:id/vods/:vodId/reUploadPart',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Re-upload a specific part of a VOD to YouTube',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            vodId: { type: 'string' },
          },
          required: ['id', 'vodId'],
        },
        body: {
          type: 'object',
          properties: {
            part: { type: 'number' },
            type: { type: 'string', enum: ['live', 'vod'] },
          },
          required: ['part', 'type'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const { id, vodId } = request.params as { id: string; vodId: string };
      const body = request.body as any;

      try {
        const config = getStreamerConfig(id);
        if (!config) throw new Error('Tenant not found');
        if (!config.youtube) throw new Error('YouTube integration not configured for this tenant');

        const client = getClient(id);
        if (!client) throw new Error('Database not available');

        const vodRecord: any = await (client as any).vod.findUnique({ where: { id: vodId } });
        if (!vodRecord) throw new Error(`VOD ${vodId} not found`);

        let videoPath;
        try {
          await fsPromises.access(`${config.settings.vodPath}/${id}/${vodId}.mp4`).catch(() => {});
          videoPath = `${config.settings.vodPath}/${id}/${vodId}.mp4`;
        } catch (err) {
          request.log.warn(`[${vodId}] MP4 file not found`);
          throw new Error('MP4 file not found. VOD may not have been processed yet.');
        }

        const youtubeJob = {
          streamerId: id,
          vodId,
          filePath: videoPath!,
          title: `Re-upload Part ${body.part}: ${vodRecord.title || vodId}`,
          description: 'Manual part re-upload triggered via admin endpoint',
          type: body.type === 'live' ? 'game' : 'vod',
          platform: vodRecord.platform as 'twitch' | 'kick',
          part: Number(body.part),
        };

        await (getYoutubeUploadQueue() as any).add(youtubeJob, { id: `youtube-part:${vodId}:${body.part}` });
        return { data: { message: `Re-upload queued for ${vodId} Part ${body.part}`, vodId } };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        request.log.error(`[${id}] Re-upload part failed: ${errorMsg}`);
        throw new Error('Failed to queue re-upload job');
      }
    }
  );

  fastify.post(
    '/:id/vods/:vodId/gameUpload',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Re-upload a game chapter from VOD to YouTube',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            vodId: { type: 'string' },
          },
          required: ['id', 'vodId'],
        },
        body: {
          type: 'object',
          properties: {
            chapterIndex: { type: 'number' },
            type: { type: 'string', enum: ['live', 'vod'] },
          },
          required: ['chapterIndex', 'type'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const { id, vodId } = request.params as { id: string; vodId: string };
      const body = request.body as any;

      try {
        const config = getStreamerConfig(id);
        if (!config) throw new Error('Tenant not found');
        if (!config.youtube) throw new Error('YouTube integration not configured for this tenant');

        const client = getClient(id);
        if (!client) throw new Error('Database not available');

        const vodRecord: any = await (client as any).vod.findUnique({ where: { id: vodId } });
        if (!vodRecord) throw new Error(`VOD ${vodId} not found`);

        const chapterList: any[] = await (client as any).chapter.findMany({ where: { vod_id: vodId }, orderBy: { start: 'asc' } });
        const gameChapter = chapterList[Number(body.chapterIndex)];
        if (!gameChapter) throw new Error(`Game chapter ${body.chapterIndex} not found`);

        let videoPath;
        try {
          await fsPromises.access(`${config.settings.vodPath}/${id}/${vodId}.mp4`).catch(() => {});
          videoPath = `${config.settings.vodPath}/${id}/${vodId}.mp4`;
        } catch (err) {
          request.log.warn(`[${vodId}] MP4 file not found`);
          throw new Error('MP4 file not found. VOD may not have been processed yet.');
        }

        const youtubeJob = {
          streamerId: id,
          vodId,
          filePath: videoPath!,
          title: `Game Chapter ${gameChapter.name}: ${vodRecord.title || vodId}`,
          description: 'Manual game chapter upload triggered via admin endpoint',
          type: body.type === 'live' ? 'game' : 'vod',
          platform: vodRecord.platform as 'twitch' | 'kick',
          chapter: {
            name: `${gameChapter.name} (${Number(gameChapter.start)}s-${gameChapter.end || Number(vodRecord.duration)}s)`,
            start: Number(gameChapter.start),
            end: gameChapter.end ? Number(gameChapter.end) : 0,
            gameId: gameChapter.game_id,
          },
        };

        await (getYoutubeUploadQueue() as any).add(youtubeJob, { id: `youtube-game:${vodId}:${body.chapterIndex}` });
        return { data: { message: `Game chapter upload queued for ${gameChapter.name} from ${vodId}`, vodId } };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        request.log.error(`[${id}] Game upload failed: ${errorMsg}`);
        throw new Error('Failed to queue game chapter upload');
      }
    }
  );

  fastify.post(
    '/:id/games/:gameId/reuploadGame',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Re-upload a specific game clip from database to YouTube',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            gameId: { type: 'number' },
          },
          required: ['id', 'gameId'],
        },
        body: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['live', 'vod'] },
          },
          required: ['type'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const { id, gameId } = request.params as { id: string; gameId: number };
      const body = request.body as any;

      try {
        const config = getStreamerConfig(id);
        if (!config) throw new Error('Tenant not found');
        if (!config.youtube) throw new Error('YouTube integration not configured for this tenant');

        const client = getClient(id);
        if (!client) throw new Error('Database not available');

        const gameRecord: any = await (client as any).game.findUnique({ where: { id: Number(gameId) } });
        if (!gameRecord) throw new Error(`Game ${gameId} not found`);

        const vodRecord: any = await (client as any).vod.findUnique({ where: { id: gameRecord.vod_id } });
        if (!vodRecord) throw new Error(`VOD ${gameRecord.vod_id} not found for this game clip`);

        let videoPath;
        try {
          await fsPromises.access(`${config.settings.vodPath}/${id}/${gameRecord.vod_id}.mp4`).catch(() => {});
          videoPath = `${config.settings.vodPath}/${id}/${gameRecord.vod_id}.mp4`;
        } catch (err) {
          request.log.warn(`[${gameRecord.vod_id}] MP4 file not found`);
          throw new Error('MP4 file not found. VOD may not have been processed yet.');
        }

        const youtubeJob = {
          streamerId: id,
          vodId: gameRecord.vod_id,
          filePath: videoPath!,
          title: `${gameRecord.game_name || 'Game Clip'} - ${vodRecord.title}`,
          description: `Re-upload of ${gameRecord.game_name} from ${vodRecord.title}. Start: ${Number(gameRecord.start_time)}s, End: ${gameRecord.end_time ? Number(gameRecord.end_time) : 0}s.`,
          type: body.type === 'live' ? 'game' : 'vod',
          platform: vodRecord.platform as 'twitch' | 'kick',
          chapter: {
            name: `${gameRecord.game_name} (${Number(gameRecord.start_time)}s-${gameRecord.end_time || Number(vodRecord.duration)}s)`,
            start: Number(gameRecord.start_time),
            end: gameRecord.end_time ? Number(gameRecord.end_time) : 0,
            gameId: String(Number(gameId)),
          },
        };

        await (getYoutubeUploadQueue() as any).add(youtubeJob, { id: `youtube-game:${gameId}:${Date.now()}` });
        return { data: { message: `Game re-upload queued for ${gameRecord.game_name} from VOD ${vodRecord.id}`, gameId: Number(gameId) } };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        request.log.error(`[${id}] Game reupload failed: ${errorMsg}`);
        throw new Error('Failed to queue game upload');
      }
    }
  );

  fastify.post(
    '/:id/live',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'External webhook handler when live HLS download completes',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            streamId: { type: 'string' },
            path: { type: 'string' },
            platform: { type: 'string', enum: ['twitch', 'kick'] },
          },
          required: ['streamId', 'path'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as any;

      if (!body.streamId || !body.path) throw new Error('Missing streamId or path');

      try {
        const client = getClient(id);
        if (!client) throw new Error('Database not available');

        let vodRecord: any;
        try {
          vodRecord = await (client as any).vod.findUnique({ where: { stream_id: body.streamId } });
        } catch {
          vodRecord = null;
        }

        if (!vodRecord) throw new Error('VOD not found for streamId');

        const config = getStreamerConfig(id);

        if (body.platform && vodRecord.platform !== body.platform) {
          request.log.warn(`[${id}] Platform mismatch: VOD=${vodRecord.platform}, param=${body.platform}`);
        }

        if (!(config?.youtube?.multiTrack || false)) {
          const err = new Error('Not Uploading to youtube as per multitrack var');
          (err as any).statusCode = 404;
          throw err;
        }

        request.log.info(`[${id}] Queuing YouTube upload for live VOD ${vodRecord.id}`);

        const finalTitle = `${config.settings.domainName} ${vodRecord.platform?.toUpperCase() || body.platform?.toUpperCase()} LIVE VOD`;

        const youtubeJobData = {
          streamerId: id,
          vodId: String(vodRecord.id),
          filePath: body.path,
          title: finalTitle,
          description: config.youtube.description || '',
          type: 'vod' as const,
          platform: (body.platform || vodRecord.platform) as 'twitch' | 'kick',
        };

        await (getYoutubeUploadQueue() as any).add(youtubeJobData, { id: `youtube-live:${vodRecord.id}:${Date.now()}` });

        return { data: { message: 'Starting upload to youtube', vodId: String(vodRecord.id) } };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const statusCode = (error as any).statusCode || 500;

        request.log.error(`[${id}] Live callback failed: ${errorMsg}`);

        if (statusCode === 404) {
          throw new Error('YouTube multi-track upload not enabled');
        }

        throw error;
      }
    }
  );

  type DmcaRequestBody = {
    vodId: string;
    claims: any[] | string;
    platform?: 'twitch' | 'kick';
    type?: 'vod' | 'live';
    partIndex?: number;
  };

  fastify.post(
    '/:id/dmca',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Process DMCA claims for a VOD (or specific part if provided) - mutes audio or applies blackout, then queues YouTube upload',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            vodId: { type: 'string' },
            claims: {},
            partIndex: { type: 'number' }, // Optional - if provided, processes only that part (1-indexed)
            platform: { type: 'string', enum: ['twitch', 'kick'] },
            type: { type: 'string', enum: ['vod', 'live'] },
          },
          required: ['vodId', 'claims'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as DmcaRequestBody;

      try {
        const config = getStreamerConfig(id);
        if (!config) throw new Error('Tenant not found');

        const client = getClient(id);
        if (!client) throw new Error('Database not available');

        let vodRecord: any;
        try {
          vodRecord = await (client as any).vod.findUnique({ where: { id: body.vodId } });
        } catch {
          vodRecord = null;
        }

        if (!vodRecord) throw new Error('VOD not found');

        const claimsArray = Array.isArray(body.claims) ? body.claims : JSON.parse(typeof body.claims === 'string' ? body.claims : JSON.stringify(body.claims));

        // Build job data - only include part field if partIndex is provided
        const dmcaJobData: any = {
          streamerId: id,
          vodId: String(vodRecord.id),
          receivedClaims: claimsArray,
          type: body.type || 'vod',
          platform: body.platform || (vodRecord.platform as 'twitch' | 'kick'),
        };

        // Only add part field if partIndex is explicitly provided and valid
        if (body.partIndex !== undefined && body.partIndex !== null) {
          dmcaJobData.part = Number(body.partIndex) + 1; // Convert to 1-indexed for worker
        }

        await (getDmcaProcessingQueue() as any).add(dmcaJobData);

        if (body.partIndex !== undefined && body.partIndex !== null) {
          request.log.info(`[${id}] DMCA processing job queued for ${body.vodId} Part ${Number(body.partIndex) + 1}`);
        } else {
          request.log.info(`[${id}] DMCA processing job queued for full VOD ${body.vodId}`);
        }

        return {
          data: {
            message: body.partIndex !== undefined ? `DMCA part processing started` : 'DMCA processing started',
            vodId: String(vodRecord.id),
            ...(body.partIndex !== undefined && { part: Number(body.partIndex) + 1 }),
          },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        request.log.error(`[${id}] DMCA failed: ${errorMsg}`);

        throw new Error('Failed to queue DMCA processing job');
      }
    }
  );

  fastify.post(
    '/:id/part-dmca',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Process DMCA claim for specific part of VOD (or full VOD if no part specified) - applies blackout, then queues YouTube upload',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            vodId: { type: 'string' },
            claims: {},
            partIndex: { type: 'number' }, // Optional - if not provided, processes full VOD like /dmca endpoint
            platform: { type: 'string', enum: ['twitch', 'kick'] },
            type: { type: 'string', enum: ['vod', 'live'] },
          },
          required: ['vodId', 'claims'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as DmcaRequestBody;

      try {
        const config = getStreamerConfig(id);
        if (!config) throw new Error('Tenant not found');

        const client = getClient(id);
        if (!client) throw new Error('Database not available');

        let vodRecord: any;
        try {
          vodRecord = await (client as any).vod.findUnique({ where: { id: body.vodId } });
        } catch {
          vodRecord = null;
        }

        if (!vodRecord) throw new Error('VOD not found');

        const claimsArray = Array.isArray(body.claims) ? body.claims : JSON.parse(typeof body.claims === 'string' ? body.claims : JSON.stringify(body.claims));

        // Build job data - only include part field if partIndex is provided
        const dmcaJobData: any = {
          streamerId: id,
          vodId: String(vodRecord.id),
          receivedClaims: claimsArray,
          type: body.type || 'vod',
          platform: body.platform || (vodRecord.platform as 'twitch' | 'kick'),
        };

        // Only add part field if partIndex is explicitly provided and valid
        if (body.partIndex !== undefined && body.partIndex !== null) {
          dmcaJobData.part = Number(body.partIndex) + 1; // Convert to 1-indexed for worker
        }

        await (getDmcaProcessingQueue() as any).add(dmcaJobData);

        if (body.partIndex !== undefined && body.partIndex !== null) {
          request.log.info(`[${id}] DMCA processing job queued for ${body.vodId} Part ${Number(body.partIndex) + 1}`);
        } else {
          request.log.info(`[${id}] DMCA processing job queued for full VOD ${body.vodId}`);
        }

        return {
          data: {
            message: body.partIndex !== undefined ? `DMCA part processing started` : 'DMCA processing started',
            vodId: String(vodRecord.id),
            ...(body.partIndex !== undefined && { part: Number(body.partIndex) + 1 }),
          },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        request.log.error(`[${id}] DMCA failed: ${errorMsg}`);

        throw new Error('Failed to queue DMCA processing job');
      }
    }
  );

  fastify.get(
    '/:id/badges/twitch',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Get Twitch badges for a channel (global + subscriber)',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };

      try {
        const config = getStreamerConfig(id);
        if (!config?.twitch?.id) throw new Error('Twitch not configured for this tenant');

        // Check Redis cache first (60-minute TTL)
        const redisInstance = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
        const cachedBadges = await redisInstance.get(`twitch_badges:${id}`);

        if (cachedBadges) {
          request.log.info(`[${id}] Returning cached Twitch badges`);
          return { data: JSON.parse(cachedBadges) };
        }

        // Fetch from Twitch API on cache miss
        const twitch = await import('../../../services/twitch.js');

        const [channelBadges, globalBadges] = await Promise.all([twitch.getChannelBadges(id).catch(() => null), twitch.getGlobalBadges(id).catch(() => null)]);

        const badgesData = { channel: channelBadges || null, global: globalBadges || null };

        // Cache in Redis with 60-minute TTL (3600 seconds)
        await redisInstance.set(`twitch_badges:${id}`, JSON.stringify(badgesData), 'EX', 3600);

        request.log.info(`[${id}] Fetched and cached Twitch badges`);

        return { data: badgesData };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        request.log.error(`[${id}] Failed to fetch Twitch badges: ${errorMsg}`);

        throw new Error('Something went wrong trying to retrieve channel badges..');
      }
    }
  );

  return fastify;
}
