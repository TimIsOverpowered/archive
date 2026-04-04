import { FastifyInstance } from 'fastify';
import path from 'path';
import type { VodData as TwitchVodData } from '../../../services/twitch.js';
import { getTenantConfig } from '../../../config/loader';
import createRateLimitMiddleware from '../../middleware/rate-limit';
import adminApiKeyMiddleware from '../../middleware/admin-api-key';
import { validateTenantPlatform, findVodRecord, parseDurationToSeconds, queueEmoteFetch } from './utils/vod-helpers';
import type { KickVod } from '../../../services/kick.js';
import { getClient } from '../../../db/client.js';
import { fileExists } from '../../../utils/path.js';
import { adminRateLimiter } from '../../plugins/redis.plugin';

type StreamerDbClient = ReturnType<typeof getClient>;

type VodRecord = {
  id: string;
  title: string | null;
  created_at: Date;
  duration: number;
  stream_id: string | null;
  platform: string;
};

interface Logger {
  info: (context: Record<string, unknown>, message: string) => void;
  debug: (context: Record<string, unknown>, message: string) => void;
  warn: (context: Record<string, unknown>, message: string) => void;
  error: (context: Record<string, unknown>, message: string) => void;
}

async function validateVodFile(tenantId: string, vodId: string, expectedDuration: number, filePath: string, log: Logger): Promise<{ valid: boolean; filePath: string }> {
  const exists = await fileExists(filePath);

  if (!exists) {
    log.debug({ tenantId, vodId, filePath }, `File does not exist`);
    return { valid: false, filePath };
  }

  const ffmpegModule = await import('../../../utils/ffmpeg.js');
  const actualDuration = await ffmpegModule.getDuration(filePath);

  if (actualDuration === null) {
    log.warn({ tenantId, vodId, filePath }, `Could not determine file duration`);
    return { valid: false, filePath };
  }

  const durationDiff = Math.abs(actualDuration - expectedDuration);

  if (durationDiff <= 1) {
    log.info({ tenantId, vodId, expectedDuration, actualDuration, filePath }, `File exists and duration is valid`);
    return { valid: true, filePath };
  }

  log.warn({ tenantId, vodId, expectedDuration, actualDuration, diff: durationDiff, filePath }, `File duration mismatch exceeds tolerance`);
  return { valid: false, filePath };
}

export default async function downloadJobsRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  if (!adminRateLimiter) {
    throw new Error('Rate limiter not initialized');
  }

  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: adminRateLimiter });

  /**
   * Shared VOD creation logic for both /download and /hlsDownload endpoints
   */
  async function ensureVodRecord(
    tenantId: string,
    vodId: string,
    platform: 'twitch' | 'kick',
    logInstance: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }
  ): Promise<VodRecord> {
    const config = getTenantConfig(tenantId);

    if (!config) throw new Error('Tenant not found');

    let client: StreamerDbClient | null = null;

    try {
      // Try to get tenant-specific client first, fall back to meta for VOD lookup
      client = getClient(tenantId);

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
          logInstance.warn(`[${tenantId}] VOD ${vodId} exists but has different platform: expected=${platform}, actual=${typedRecord.platform}`);
        }

        logInstance.info(`[${tenantId}] Using existing VOD record for ${vodId}`);

        return vodRecord;
      }

      // Create new VOD record by fetching metadata from platform API
      logInstance.info(`[${tenantId}] Creating new VOD ${vodId} for platform ${platform}`);

      if (platform === 'twitch') {
        const twitch = await import('../../../services/twitch');
        const vodMetadata: TwitchVodData = await twitch.getVodData(vodId, tenantId);

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

        logInstance.info(`[${tenantId}] Created Twitch VOD ${vodId} with user_id=${vodMetadata.user_id}`);
      } else if (platform === 'kick') {
        const kick = await import('../../../services/kick');

        if (!config.kick?.username) {
          throw new Error('Kick username not configured for this tenant');
        }

        const vodMetadata: KickVod = await kick.getVod(config.kick.username, vodId);

        logInstance.info(`[${tenantId}] Fetched Kick VOD ${vodId} from channel ${config.kick.username}`);

        vodRecord = (await client.vod.create({
          data: {
            id: String(vodId),
            title: vodMetadata.session_title || null,
            created_at: new Date(vodMetadata.created_at),
            duration: Math.floor(Number(vodMetadata.duration) / 1000), // Convert ms to seconds
            stream_id: `${vodMetadata.id}`,
            platform: 'kick',
          },
        })) as VodRecord;

        logInstance.info(`[${tenantId}] Created Kick VOD ${vodId} with duration=${Number(vodMetadata.duration)}ms`);
      } else {
        throw new Error('Unsupported platform');
      }

      return vodRecord;
    } catch (error: unknown) {
      if (!client) {
        logInstance.error(`[${tenantId}] Database not available for VOD creation`);
      }

      throw error;
    }
  }

  // Main download endpoint - creates VOD record if missing, then queues download + emote + chat jobs + upload (Twitch/Kick)
  fastify.post<{
    Body: { vodId: string; type?: 'live' | 'vod'; platform: 'twitch' | 'kick'; path?: string; uploadMode?: 'vod' | 'all'; mode?: 'hls' | 'mp4' };
    Params: { id: string };
  }>(
    '/:id/upload',
    {
      schema: {
        tags: ['Admin'],
        description: 'Create VOD record if missing, then queue download + emote + chat jobs (Twitch/Kick)',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          properties: {
            vodId: { type: 'string' },
            type: { type: 'string', enum: ['live', 'vod'], default: 'vod' },
            platform: { type: 'string', enum: ['twitch', 'kick'] },
            mode: { type: 'string', enum: ['hls', 'mp4'], default: 'hls' },
            uploadMode: { type: 'string', enum: ['vod', 'all'], default: 'all' },
          },
          required: ['vodId', 'platform'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const tenantId = request.params.id;

      try {
        // Validate tenant and platform enablement
        const platform = request.body.platform;
        const validation = validateTenantPlatform(tenantId, platform);

        if (validation.error) throw validation.error;

        // Get config for reference to username fields if needed
        const config = validation.config;

        // Ensure VOD record exists or create it from platform API metadata
        const vodRecord: VodRecord | null = await ensureVodRecord(tenantId, request.body.vodId, request.body.platform as 'twitch' | 'kick', request.log);

        if (!vodRecord) {
          throw new Error('Failed to create VOD record');
        }

        // Queue emote save job (fire-and-forget within request context)
        const platformId = config?.[platform]?.id;

        if (platformId) {
          await queueEmoteFetch({
            tenantId,
            vodId: vodRecord.id,
            platform: request.body.platform as 'twitch' | 'kick',
            platformId,
            log: request.log,
          });
        } else {
          request.log.warn(`[${tenantId}] No platform ID available for emote fetching on VOD ${request.body.vodId}`);
        }

        // Determine file path based on type
        const type = request.body.type;
        const streamerConfig = getTenantConfig(tenantId);
        const filePath =
          type === 'live'
            ? streamerConfig?.settings.livePath
              ? path.join(streamerConfig.settings.livePath, tenantId, `${vodRecord.id}.mp4`)
              : ''
            : streamerConfig?.settings.vodPath
              ? path.join(streamerConfig.settings.vodPath, tenantId, `${vodRecord.id}.mp4`)
              : '';

        // File validation before download
        let skipDownload = false;

        if (filePath) {
          const validation = await validateVodFile(tenantId, vodRecord.id, vodRecord.duration, filePath, request.log);

          if (validation.valid) {
            skipDownload = true;
          }
        }

        // Queue VOD download job
        if (request.body.mode === 'hls') {
          // Live stream HLS download - queue job for hls-downloader.ts handler

          if (skipDownload) {
            const { queueYoutubeUpload } = await import('../../../utils/upload-queue.js');

            await queueYoutubeUpload(tenantId, vodRecord.id, filePath, request.body.uploadMode || 'all', request.body.platform, request.log);

            return {
              data: {
                message: 'Live file already exists and validated, upload queued',
                vodId: vodRecord.id,
                path: filePath,
                platform: request.body.platform,
              },
            };
          }

          const VodQueueModule = await import('../../../jobs/queues');

          const vodDownloadJob = {
            tenantId: tenantId,
            platformUserId: tenantId,
            vodId: request.body.vodId,
            platform,
            uploadAfterDownload: true,
            uploadMode: request.body.uploadMode || 'all',
          };

          void VodQueueModule.getVODDownloadQueue().add('vod_download', vodDownloadJob, {
            jobId: `download_${request.body.vodId}`,
          });

          const vodJobId = `download_${request.body.vodId}`;

          // Calculate duration for chat download job
          const durationSeconds = parseDurationToSeconds(vodRecord.duration, request.body.platform as 'twitch' | 'kick');

          void VodQueueModule.getChatDownloadQueue().add(
            'chat_download',
            { tenantId: tenantId, platformUserId: tenantId, vodId: request.body.vodId, platform: request.body.platform as 'twitch' | 'kick', duration: durationSeconds },
            { jobId: `chat_${request.body.vodId}` }
          );

          const chatJobId = `chat_${request.body.vodId}`;

          request.log.info(`[${tenantId}] Queued live HLS download jobs for ${request.body.vodId}: vod=${vodJobId}, chat=${chatJobId}`);

          return { data: { message: 'Live HLS download queued', vodId: request.body.vodId, jobId: vodJobId, chatJobId } };
        } else if (request.body.mode === 'mp4') {
          // Standard archived VOD re-download - queue job for standard-vod-downloader.ts handler

          if (skipDownload && filePath) {
            const { queueYoutubeUpload } = await import('../../../utils/upload-queue.js');

            await queueYoutubeUpload(tenantId, vodRecord.id, filePath, request.body.uploadMode || 'all', request.body.platform, request.log);

            return {
              data: {
                message: 'File already exists and validated, upload queued',
                vodId: vodRecord.id,
                path: filePath,
                platform: request.body.platform,
              },
            };
          }

          const VodQueueModule = await import('../../../jobs/queues');

          const vodDownloadJob = {
            tenantId: tenantId,
            platformUserId: tenantId,
            vodId: request.body.vodId,
            platform,
            uploadMode: request.body.uploadMode || 'all',
          };

          void VodQueueModule.getVODDownloadQueue().add('standard_vod_download', vodDownloadJob, {
            jobId: `download_${request.body.vodId}`,
          });

          const vodJobId = `download_${request.body.vodId}`;

          // Calculate duration for chat download job
          const durationSeconds = parseDurationToSeconds(vodRecord.duration, request.body.platform as 'twitch' | 'kick');

          void VodQueueModule.getChatDownloadQueue().add(
            'chat_download',
            { tenantId: tenantId, platformUserId: tenantId, vodId: request.body.vodId, platform, duration: durationSeconds },
            { jobId: `chat_${request.body.vodId}` }
          );

          const chatJobId = `chat_${request.body.vodId}`;

          request.log.info(`[${tenantId}] Queued standard VOD download jobs for ${request.body.vodId}: vod=${vodJobId}, chat=${chatJobId}`);

          return { data: { message: 'VOD download queued', vodId: request.body.vodId, jobId: vodJobId, chatJobId } };
        } else {
          throw new Error('Download mode must be "hls" or "mp4"');
        }
      } catch (error) {
        request.log.error({ err: error }, `[${tenantId}] Download failed`);
        throw error;
      }
    }
  );
  return fastify;
}
