import { FastifyInstance } from 'fastify';
import createRateLimitMiddleware from '../../middleware/rate-limit';
import adminApiKeyMiddleware from '../../middleware/admin-api-key';
import { tenantMiddleware, platformValidationMiddleware, type TenantPlatformContext } from '../../middleware/tenant-platform';
import { parseDurationToSeconds, ensureVodRecord, findVodRecord } from './utils/vod-helpers';
import { adminRateLimiter } from '../../plugins/redis.plugin';
import { createAutoLogger } from '../../../utils/auto-tenant-logger.js';
import { notFound } from '../../../utils/http-error';
import type { Platform, SourceType, DownloadMethod, UploadMode } from '../../../types/platforms.js';
import { SOURCE_TYPES, DOWNLOAD_METHODS, UPLOAD_MODES, PLATFORM_VALUES, UPLOAD_MODE_VALUES, DOWNLOAD_METHODS_VALUES, SOURCE_TYPES_VALUES } from '../../../types/platforms.js';
import { fetchAndSaveEmotes } from '../../../services/emotes';
import { getStandardVodQueue, getChatDownloadQueue } from '../../../workers/jobs/queues.js';

interface ReDownloadVodParams {
  tenantId: string;
}

interface ReDownloadVodBody {
  vodId: string;
  platform: Platform;
  downloadMethod?: DownloadMethod;
  type?: SourceType;
}

export default async function downloadJobsRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  if (!adminRateLimiter) {
    throw new Error('Rate limiter not initialized');
  }

  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: adminRateLimiter });

  // Main download endpoint - creates VOD record if missing, then queues download + emote + chat jobs + upload (Twitch/Kick)
  fastify.post<{
    Body: { vodId: string; type?: SourceType; platform: Platform; path?: string; uploadMode?: UploadMode; downloadMethod?: DownloadMethod };
    Params: { tenantId: string };
  }>(
    '/upload',
    {
      schema: {
        tags: ['Admin'],
        description: 'Create VOD record if missing, then queue download + emote + chat jobs (Twitch/Kick)',
        params: { type: 'object', properties: { tenantId: { type: 'string', minLength: 1, maxLength: 100, description: 'Tenant ID' } }, required: ['tenantId'] },
        body: {
          type: 'object',
          properties: {
            vodId: { type: 'string', minLength: 1, maxLength: 100 },
            type: { type: 'string', enum: SOURCE_TYPES_VALUES, default: SOURCE_TYPES.VOD },
            platform: { type: 'string', enum: PLATFORM_VALUES },
            uploadMode: { type: 'string', enum: UPLOAD_MODE_VALUES, default: UPLOAD_MODES.ALL },
            downloadMethod: { type: 'string', enum: DOWNLOAD_METHODS_VALUES, default: DOWNLOAD_METHODS.HLS },
          },
          required: ['vodId', 'platform'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware, tenantMiddleware],
      preValidation: [platformValidationMiddleware],
    },
    async (request) => {
      const { tenantId, config, db, platform } = request.tenant as TenantPlatformContext;
      const log = createAutoLogger(tenantId);

      // Ensure VOD record exists or create it from platform API metadata
      const vodRecord = await ensureVodRecord(config, db, tenantId, request.body.vodId, platform, log);

      if (!vodRecord) {
        notFound(`VOD ${request.body.vodId} not found on ${platform}`);
      }

      // Queue emote save job (fire-and-forget within request context)
      const platformId = config?.[platform]?.id;

      if (platformId) {
        await fetchAndSaveEmotes(request.tenant as TenantPlatformContext, vodRecord.id, platform, platformId);
      } else {
        log.warn(`No platform ID available for emote fetching on VOD ${request.body.vodId}`);
      }

      const type = request.body.type;

      // For live streams, use stream_id; for archived, use vod_id
      const fileIdentifier = type === SOURCE_TYPES.LIVE ? vodRecord.stream_id || vodRecord.vod_id : vodRecord.vod_id;

      // Queue download job (fire-and-forget)
      const downloadJob = {
        tenantId,
        platformUserId: tenantId,
        dbId: vodRecord.id,
        vodId: fileIdentifier,
        platform,
        uploadMode: request.body.uploadMode || UPLOAD_MODES.ALL,
        downloadMethod: request.body.downloadMethod || DOWNLOAD_METHODS.HLS,
      };

      const downloadJobId = `download_${vodRecord.vod_id}`;

      void getStandardVodQueue().add('standard_vod_download', downloadJob, { jobId: downloadJobId });

      log.info({ vodId: vodRecord.vod_id, downloadJobId }, 'VOD download queued, YouTube upload will be triggered after completion');

      // Queue chat download job
      const durationSeconds = parseDurationToSeconds(vodRecord.duration, platform);

      void getChatDownloadQueue().add(
        'chat_download',
        { tenantId: tenantId, platformUserId: tenantId, dbId: vodRecord.id, vodId: vodRecord.vod_id, platform, duration: durationSeconds },
        { jobId: `chat_${vodRecord.vod_id}` }
      );

      const chatJobId = `chat_${vodRecord.vod_id}`;

      return {
        data: {
          message: 'VOD download queued, YouTube upload will be triggered after completion',
          dbId: vodRecord.id,
          vodId: vodRecord.vod_id,
          downloadJobId,
          chatJobId,
        },
      };
    }
  );

  // Manually trigger VOD download
  fastify.post<{ Params: ReDownloadVodParams; Body: ReDownloadVodBody }>(
    '/vods/re-download',
    {
      schema: {
        tags: ['Admin'],
        description: 'Manually trigger VOD download',
        params: { type: 'object', properties: { tenantId: { type: 'string', description: 'Tenant ID' } }, required: ['tenantId'] },
        body: {
          type: 'object',
          properties: {
            vodId: { type: 'string', description: 'Platform VOD ID' },
            platform: { type: 'string', enum: PLATFORM_VALUES, description: 'Source platform' },
            downloadMethod: { type: 'string', enum: DOWNLOAD_METHODS_VALUES, default: DOWNLOAD_METHODS.HLS, description: 'Download method' },
            type: { type: 'string', enum: SOURCE_TYPES_VALUES, default: SOURCE_TYPES.VOD, description: 'File type for checking' },
          },
          required: ['vodId', 'platform'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware, tenantMiddleware],
      preValidation: [platformValidationMiddleware],
    },
    async (request) => {
      const { tenantId, db, platform } = request.tenant as TenantPlatformContext;
      const { vodId, downloadMethod, type } = request.body;

      const vodRecord = await findVodRecord(db, vodId, platform);

      if (!vodRecord) notFound(`VOD ${vodId} not found`);

      const fileIdentifier = type === SOURCE_TYPES.LIVE ? vodRecord.stream_id || vodRecord.vod_id : vodRecord.vod_id;

      const downloadJob = {
        tenantId,
        platformUserId: tenantId,
        dbId: vodRecord.id,
        vodId: fileIdentifier,
        platform,
        downloadMethod: downloadMethod || DOWNLOAD_METHODS.HLS,
      };

      const downloadJobId = `download_${vodRecord.vod_id}`;

      void getStandardVodQueue().add('standard_vod_download', downloadJob, { jobId: downloadJobId });

      return { data: { message: 'VOD download queued', dbId: vodRecord.id, vodId: vodRecord.vod_id, downloadJobId } };
    }
  );

  return fastify;
}
