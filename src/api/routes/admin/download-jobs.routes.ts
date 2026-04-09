import { FastifyInstance } from 'fastify';
import type { VodData as TwitchVodData } from '../../../services/twitch.js';
import { getTenantConfig } from '../../../config/loader';
import createRateLimitMiddleware from '../../middleware/rate-limit';
import adminApiKeyMiddleware from '../../middleware/admin-api-key';
import { validateTenantPlatform, findVodRecord, parseDurationToSeconds, queueEmoteFetch } from './utils/vod-helpers';
import type { KickVod } from '../../../services/kick.js';
import { getClient } from '../../../db/client.js';
import { fileExists } from '../../../utils/path.js';
import { adminRateLimiter } from '../../plugins/redis.plugin';
import { createAutoLogger } from '../../../utils/auto-tenant-logger.js';
import { notFound, serviceUnavailable, badRequest } from '../../../utils/http-error';

type StreamerDbClient = ReturnType<typeof getClient>;

type VodRecord = {
  id: number;
  vod_id: string;
  title: string | null;
  created_at: Date;
  duration: number;
  stream_id: string | null;
  platform: string;
};

type Logger = ReturnType<typeof createAutoLogger>;

async function validateVodFile(tenantId: string, vodId: number, expectedDuration: number, filePath: string, log: Logger): Promise<{ valid: boolean; filePath: string }> {
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
  async function ensureVodRecord(tenantId: string, vodId: string | number, platform: 'twitch' | 'kick', logInstance: Logger): Promise<VodRecord> {
    const config = getTenantConfig(tenantId);

    if (!config) notFound('Tenant not found');

    let client: StreamerDbClient | null = null;

    try {
      // Try to get tenant-specific client first, fall back to meta for VOD lookup
      client = getClient(tenantId);

      if (!client) serviceUnavailable('Database not available');

      let vodRecord: VodRecord | null = null;
      try {
        const rawVodRecord = await findVodRecord(client, vodId, platform);
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
          logInstance.warn(`VOD ${vodId} exists but has different platform: expected=${platform}, actual=${typedRecord.platform}`);
        }

        logInstance.info(`Using existing VOD record for ${vodId}`);

        return vodRecord;
      }

      // Create new VOD record by fetching metadata from platform API
      logInstance.info(`Creating new VOD ${vodId} for platform ${platform}`);

      try {
        if (platform === 'twitch') {
          const twitch = await import('../../../services/twitch');
          const vodMetadata: TwitchVodData = await twitch.getVodData(String(vodId), tenantId);

          // Validate ownership
          if (!config.twitch?.id || vodMetadata.user_id !== config.twitch.id) {
            badRequest('This VOD belongs to another Twitch channel');
          }

          const durationStr = String(vodMetadata.duration);
          const durationParts: string[] = durationStr.replace('PT', '').split(/[HMS]/);
          let totalSeconds = 0;

          if (durationParts.length >= 3 && !isNaN(parseInt(durationParts[1]))) {
            totalSeconds += parseInt(durationParts[0] || '0') * 3600 + parseInt(durationParts[1]) * 60 + parseInt(durationParts[2]);
          }

          vodRecord = (await client.vod.create({
            data: {
              vod_id: String(vodId),
              title: vodMetadata.title || null,
              created_at: new Date(vodMetadata.created_at),
              duration: totalSeconds,
              stream_id: vodMetadata.stream_id || null,
              platform: 'twitch',
            },
          })) as VodRecord;

          logInstance.info(`Created Twitch VOD ${vodId} with user_id=${vodMetadata.user_id}`);
        } else if (platform === 'kick') {
          const kick = await import('../../../services/kick');

          if (!config.kick?.username) {
            badRequest('Kick username not configured for this tenant');
          }

          const vodMetadata: KickVod = await kick.getVod(config.kick.username, String(vodId));

          logInstance.info(`Fetched Kick VOD ${vodId} from channel ${config.kick.username}`);

          vodRecord = (await client.vod.create({
            data: {
              vod_id: String(vodId),
              title: vodMetadata.session_title || null,
              created_at: new Date(vodMetadata.created_at),
              duration: Math.floor(Number(vodMetadata.duration) / 1000),
              stream_id: `${vodMetadata.id}`,
              platform: 'kick',
            },
          })) as VodRecord;

          logInstance.info(`Created Kick VOD ${vodId} with duration=${Number(vodMetadata.duration)}ms`);
        } else {
          badRequest('Unsupported platform');
        }

        return vodRecord;
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Convert "not found" errors to 404
        if (errorMessage.includes('not found') || errorMessage.includes('VOD')) {
          notFound(`VOD ${vodId} not found on ${platform}`);
        }

        // Re-throw other errors (will be handled by caller or Fastify error handler)
        throw error;
      }
    } catch (error: unknown) {
      if (!client) {
        logInstance.error('Database not available for VOD creation');
      }

      throw error;
    }
  }

  // Main download endpoint - creates VOD record if missing, then queues download + emote + chat jobs + upload (Twitch/Kick)
  fastify.post<{
    Body: { vodId: string | number; type?: 'live' | 'vod'; platform: 'twitch' | 'kick'; path?: string; uploadMode?: 'vod' | 'all'; downloadMethod?: 'ffmpeg' | 'hls' };
    Params: { tenantId: string };
  }>(
    '/:tenantId/upload',
    {
      schema: {
        tags: ['Admin'],
        description: 'Create VOD record if missing, then queue download + emote + chat jobs (Twitch/Kick)',
        params: { type: 'object', properties: { tenantId: { type: 'string', minLength: 1, maxLength: 100, description: 'Tenant ID' } }, required: ['tenantId'] },
        body: {
          type: 'object',
          properties: {
            vodId: { type: 'string', minLength: 1, maxLength: 100 },
            type: { type: 'string', enum: ['live', 'vod'], default: 'vod' },
            platform: { type: 'string', enum: ['twitch', 'kick'] },
            uploadMode: { type: 'string', enum: ['vod', 'all'], default: 'all' },
            downloadMethod: { type: 'string', enum: ['ffmpeg', 'hls'], default: 'hls' },
          },
          required: ['vodId', 'platform'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const tenantId = request.params.tenantId;
      const log = createAutoLogger(tenantId);

      // Validate tenant and platform enablement
      const platform = request.body.platform;
      const validation = validateTenantPlatform(tenantId, platform);

      if (validation.error) throw validation.error;

      // Get config for reference to username fields if needed
      const config = validation.config;

      // Ensure VOD record exists or create it from platform API metadata
      const vodRecord = await ensureVodRecord(tenantId, request.body.vodId, request.body.platform as 'twitch' | 'kick', log);

      // Queue emote save job (fire-and-forget within request context)
      const platformId = config?.[platform]?.id;

      if (platformId) {
        await queueEmoteFetch({
          tenantId,
          vodId: vodRecord.id,
          platform: request.body.platform as 'twitch' | 'kick',
          platformId,
          log,
        });
      } else {
        log.warn(`No platform ID available for emote fetching on VOD ${request.body.vodId}`);
      }

      // Determine file path based on type
      const type = request.body.type;
      const { getVodFilePath, getLiveFilePath } = await import('../../../utils/path.js');

      // For live streams, use stream_id; for archived, use vod_id
      const filePath = type === 'live' ? getLiveFilePath({ tenantId, streamId: vodRecord.stream_id || vodRecord.vod_id }) : getVodFilePath({ tenantId, vodId: vodRecord.vod_id });

      // File validation before download
      let skipDownload = false;

      if (filePath) {
        const validation = await validateVodFile(tenantId, vodRecord.id, vodRecord.duration, filePath, log);

        if (validation.valid) {
          skipDownload = true;
        }
      }

      // Queue VOD download job (standard archived VOD download)

      if (skipDownload && filePath) {
        const { queueYoutubeUpload } = await import('../../../utils/upload-queue.js');

        await queueYoutubeUpload(tenantId, vodRecord.id, vodRecord.vod_id, filePath, request.body.uploadMode || 'all', request.body.platform, log);

        return {
          data: {
            message: 'File already exists and validated, upload queued',
            dbId: vodRecord.id,
            vodId: vodRecord.vod_id,
            path: filePath,
            platform: request.body.platform,
          },
        };
      }

      const VodQueueModule = await import('../../../jobs/queues');

      const vodDownloadJob = {
        tenantId: tenantId,
        platformUserId: tenantId,
        dbId: vodRecord.id,
        vodId: vodRecord.vod_id,
        platform,
        uploadMode: request.body.uploadMode || 'all',
        downloadMethod: request.body.downloadMethod || 'hls',
      };

      void VodQueueModule.getVODDownloadQueue().add('standard_vod_download', vodDownloadJob, {
        jobId: `download_${vodRecord.vod_id}`,
      });

      const vodJobId = `download_${vodRecord.vod_id}`;

      // Calculate duration for chat download job
      const durationSeconds = parseDurationToSeconds(vodRecord.duration, request.body.platform as 'twitch' | 'kick');

      void VodQueueModule.getChatDownloadQueue().add(
        'chat_download',
        { tenantId: tenantId, platformUserId: tenantId, dbId: vodRecord.id, vodId: vodRecord.vod_id, platform, duration: durationSeconds },
        { jobId: `chat_${vodRecord.vod_id}` }
      );

      const chatJobId = `chat_${vodRecord.vod_id}`;

      log.info(`Queued standard VOD download jobs for ${vodRecord.vod_id}: vod=${vodJobId}, chat=${chatJobId}`);

      return { data: { message: 'VOD download queued', dbId: vodRecord.id, vodId: vodRecord.vod_id, jobId: vodJobId, chatJobId } };
    }
  );
  return fastify;
}
