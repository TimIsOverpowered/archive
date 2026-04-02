import { FastifyInstance } from 'fastify';
import { extractErrorDetails } from '../../../utils/error.js';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import type { VodData as TwitchVodData } from '../../../services/twitch.js';
import { getStreamerConfig } from '../../../config/loader';
import createRateLimitMiddleware from '../../middleware/rate-limit';
import adminApiKeyMiddleware from '../../middleware/admin-api-key';
import { validateTenantPlatform, findVodRecord, parseDurationToSeconds, queueEmoteFetch } from './utils/vod-helpers';
import type { KickVod } from '../../../services/kick.js';
import { getClient } from '../../../db/client.js';

declare module 'fastify' {
  interface FastifyInstance {
    adminRateLimiter: RateLimiterRedis;
  }
}

type StreamerDbClient = ReturnType<typeof getClient>;

type VodRecord = {
  id: string;
  title: string | null;
  created_at: Date;
  duration: number;
  stream_id: string | null;
  platform: string;
};

export default async function downloadJobsRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: fastify.adminRateLimiter });

  /**
   * Shared VOD creation logic for both /download and /hlsDownload endpoints
   */
  async function ensureVodRecord(
    streamerId: string,
    vodId: string,
    platform: 'twitch' | 'kick',
    logInstance: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }
  ): Promise<VodRecord> {
    const config = getStreamerConfig(streamerId);

    if (!config) throw new Error('Tenant not found');

    let client: StreamerDbClient | null = null;

    try {
      // Try to get tenant-specific client first, fall back to meta for VOD lookup
      client = getClient(streamerId);

      if (!client) throw new Error('Database not available');

      let vodRecord: VodRecord | null = null;
      try {
        const rawVodRecord = await findVodRecord(client, vodId);
        if (rawVodRecord) {
          vodRecord = rawVodRecord as VodRecord;
        }
      } catch {
        // VOD not found or error looking up
      }

      // VOD exists - return it with platform validation warning if needed
      if (vodRecord) {
        const typedRecord: Record<string, unknown> = vodRecord as Record<string, unknown>;
        if ((typedRecord.platform as string | undefined) !== platform) {
          logInstance.warn(`[${streamerId}] VOD ${vodId} exists but has different platform: expected=${platform}, actual=${typedRecord.platform}`);
        }

        logInstance.info(`[${streamerId}] Using existing VOD record for ${vodId}`);

        return vodRecord;
      }

      // Create new VOD record by fetching metadata from platform API
      logInstance.info(`[${streamerId}] Creating new VOD ${vodId} for platform ${platform}`);

      if (platform === 'twitch') {
        const twitch = await import('../../../services/twitch');
        const vodMetadata: TwitchVodData = await twitch.getVodData(vodId, streamerId);

        // Validate ownership
        if (!config.twitch?.id || vodMetadata.user_id !== config.twitch.id) {
          throw new Error('This VOD belongs to another Twitch channel');
        }

        const durationStr = String(vodMetadata.duration);
        const durationParts: string[] = durationStr.replace('PT', '').split(/[HMS]/);
        let totalSeconds = 0;

        if (durationParts.length >= 3 && !isNaN(parseInt(durationParts[1]))) {
          totalSeconds += parseInt(durationParts[0] || '0') * 3600 + parseInt(durationParts[1]) * 60 + parseInt(durationParts[2]);
        }

        vodRecord = (await client.vod.create({
          data: {
            id: vodId,
            title: vodMetadata.title || null,
            created_at: new Date(vodMetadata.created_at),
            duration: totalSeconds,
            stream_id: vodMetadata.stream_id || null,
            platform: 'twitch',
          },
        })) as VodRecord;

        logInstance.info(`[${streamerId}] Created Twitch VOD ${vodId} with user_id=${vodMetadata.user_id}`);
      } else if (platform === 'kick') {
        const kick = await import('../../../services/kick');

        if (!config.kick?.username) {
          throw new Error('Kick username not configured for this tenant');
        }

        const vodMetadata: KickVod = await kick.getVod(config.kick.username, vodId);

        logInstance.info(`[${streamerId}] Fetched Kick VOD ${vodId} from channel ${config.kick.username}`);

        vodRecord = (await client.vod.create({
          data: {
            id: String(vodId),
            title: vodMetadata.title || null,
            created_at: new Date(vodMetadata.created_at),
            duration: Math.floor(Number(vodMetadata.duration) / 1000), // Convert ms to seconds
            stream_id: `${vodMetadata.id}`,
            platform: 'kick',
          },
        })) as VodRecord;

        logInstance.info(`[${streamerId}] Created Kick VOD ${vodId} with duration=${Number(vodMetadata.duration)}ms`);
      } else {
        throw new Error('Unsupported platform');
      }

      return vodRecord;
    } catch (error: unknown) {
      if (!client) {
        logInstance.error(`[${streamerId}] Database not available for VOD creation`);
      }

      throw error;
    }
  }

  // Main download endpoint - creates VOD record if missing, then queues download + emote + chat jobs (Twitch/Kick)
  fastify.post<{
    Body: { vodId: string; type?: 'live' | 'vod'; platform: 'twitch' | 'kick'; path?: string };
    Params: { id: string };
  }>(
    '/:id/download',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Create VOD record if missing, then queue download + emote + chat jobs (Twitch/Kick)',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
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
      const streamerId = request.params.id;

      try {
        // Get config for reference to username fields if needed
        const config = getStreamerConfig(streamerId);

        // Validate tenant and platform enablement
        const platform = request.body.platform;
        const validation = validateTenantPlatform(streamerId, platform);

        if (validation.error) throw validation.error;

        // Ensure VOD record exists or create it from platform API metadata
        const vodRecord: VodRecord | null = await ensureVodRecord(streamerId, request.body.vodId, request.body.platform as 'twitch' | 'kick', request.log);

        if (!vodRecord) {
          throw new Error('Failed to create VOD record');
        }

        // Queue emote save job (fire-and-forget within request context)
        const channelId = vodRecord.stream_id ? String(vodRecord.stream_id) : undefined;

        if (channelId) {
          await queueEmoteFetch({
            streamerId,
            vodId: request.body.vodId,
            platform: request.body.platform as 'twitch' | 'kick',
            channelId,
            log: request.log,
          });
        } else {
          request.log.warn(`[${streamerId}] No channel ID available for emote fetching on VOD ${request.body.vodId}`);
        }

        // Queue VOD download job

        // Handle download based on type (vod = archived, live = streaming)
        if (request.body.type === 'live') {
          // Live stream HLS download - queue job for hls-downloader.ts handler

          const VodQueueModule = await import('../../../jobs/queues');

          const vodDownloadJob = { streamerId, vodId: request.body.vodId, platform };

          void VodQueueModule.getVODDownloadQueue().add('vod_download', vodDownloadJob, {
            jobId: `download:${request.body.vodId}:${Date.now()}`,
          });

          const vodJobId = `download:${request.body.vodId}:${Date.now()}`;

          // Calculate duration for chat download job
          const durationSeconds = parseDurationToSeconds(vodRecord.duration, request.body.platform as 'twitch' | 'kick');

          void VodQueueModule.getChatDownloadQueue().add(
            'chat_download',
            { streamerId, vodId: request.body.vodId, platform: request.body.platform as 'twitch' | 'kick', duration: durationSeconds },
            { jobId: `chat:${request.body.vodId}:${Date.now()}` }
          );

          const chatJobId = `chat:${request.body.vodId}:${Date.now()}`;

          request.log.info(`[${streamerId}] Queued live HLS download jobs for ${request.body.vodId}: vod=${vodJobId}, chat=${chatJobId}`);

          return { data: { message: 'Live HLS download queued', vodId: request.body.vodId, jobId: vodJobId, chatJobId } };
        } else if (request.body.type === 'vod' || !request.body.type) {
          // Standard archived VOD re-download - use platform-specific MP4 functions directly with Discord alerts

          if (platform === 'kick') {
            const kickModule = await import('../../../services/kick.js');

            // Fetch VOD metadata to get source URL
            const username = config?.kick?.username;

            if (!username) {
              throw new Error('Kick username not configured for streamer');
            }

            const vodMetadata: KickVod = await kickModule.getVod(username, request.body.vodId);

            if (!vodMetadata) {
              throw new Error(`Kick VOD ${request.body.vodId} not found`);
            }

            // Call MP4 download with Discord alerts built-in
            const outputPath = await kickModule.downloadMP4(streamerId, vodMetadata);

            if (!outputPath) {
              throw new Error(`Failed to download Kick VOD ${request.body.vodId}`);
            }

            return { data: { message: 'Kick VOD downloaded successfully', vodId: request.body.vodId, path: outputPath, platform: 'kick' } };
          } else if (platform === 'twitch') {
            const twitchModule = await import('../../../services/twitch.js');

            // Call MP4 download with Discord alerts built-in
            const outputPath = await twitchModule.downloadVodAsMp4(request.body.vodId, streamerId);

            if (!outputPath) {
              throw new Error(`Failed to download Twitch VOD ${request.body.vodId}`);
            }

            return { data: { message: 'Twitch VOD downloaded successfully', vodId: request.body.vodId, path: outputPath, platform: 'twitch' } };
          } else {
            throw new Error(`Unsupported platform for MP4 download: ${platform}`);
          }
        } else {
          throw new Error('VOD type must be "vod" (archived) or "live"');
        }
      } catch (error) {
        request.log.error({ err: error }, `[${streamerId}] Download failed`);
        throw error;
      }
    }
  );

  // Convenience endpoint - trigger VOD + chat download together (Twitch/Kick with optional platform param)
  fastify.post<{
    Body: { vodId: string; platform?: 'twitch' | 'kick'; skipEmotes?: boolean };
    Params: { id: string };
  }>(
    '/:id/hlsDownload',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Convenience endpoint - trigger VOD + chat download together (Twitch/Kick with optional platform param)',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          properties: {
            vodId: { type: 'string' },
            platform: { type: 'string', enum: ['twitch', 'kick'] },
            skipEmotes: { type: 'boolean' },
          },
          required: ['vodId'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const streamerId = request.params.id;

      try {
        // Default to Twitch for backward compatibility if platform not specified
        const platform = (request.body.platform as 'twitch' | 'kick') || 'twitch';

        // Validate tenant and platform enablement
        const validation = validateTenantPlatform(streamerId, platform);

        if (validation.error) throw validation.error;

        // Ensure VOD record exists or create it from platform API metadata
        const vodRecord: VodRecord = await ensureVodRecord(streamerId, request.body.vodId, platform, request.log);

        if (!vodRecord) {
          throw new Error('Failed to create VOD record');
        }

        // Queue emote save (fire-and-forget)
        const channelId = vodRecord.stream_id ? String(vodRecord.stream_id) : undefined;

        if (channelId && !request.body.skipEmotes) {
          await queueEmoteFetch({
            streamerId,
            vodId: request.body.vodId,
            platform: platform,
            channelId,
            log: request.log,
          });

          request.log.info(`[${streamerId}] Queued async emote fetch for hlsDownload VOD ${request.body.vodId} (channel=${channelId})`);
        }

        // Queue VOD download job
        const vodDownloadJob = { streamerId, vodId: request.body.vodId, platform: platform };

        const VodQueueModule = await import('../../../jobs/queues');

        void VodQueueModule.getVODDownloadQueue().add('vod_download', vodDownloadJob, {
          jobId: `hls:${request.body.vodId}:${Date.now()}`,
        });

        // Queue chat download job
        const durationSeconds = parseDurationToSeconds(vodRecord.duration, platform);

        void VodQueueModule.getChatDownloadQueue().add(
          'chat_download',
          { streamerId, vodId: request.body.vodId, platform: platform, duration: durationSeconds },
          {
            jobId: `hls-chat:${request.body.vodId}:${Date.now()}`,
          }
        );

        request.log.info(`[${streamerId}] Queued HLS download jobs for ${request.body.vodId} (platform=${platform})`);

        return { data: { message: 'HLS download jobs queued', vodId: request.body.vodId, platform, jobId: `hls:${request.body.vodId}:${Date.now()}` } };
      } catch (error) {
        const details = extractErrorDetails(error);
        const errorMsg = details.message;
        request.log.error(`[${streamerId}] HLS download failed for ${request.body.vodId}: ${errorMsg}`);

        throw new Error('Failed to queue HLS download jobs');
      }
    }
  );

  return fastify;
}
