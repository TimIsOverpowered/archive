import { FastifyInstance } from 'fastify';
import createRateLimitMiddleware from '../../middleware/rate-limit';
import adminApiKeyMiddleware from '../../middleware/admin-api-key';
import { tenantMiddleware, platformValidationMiddleware, type TenantPlatformContext } from '../../middleware/tenant-platform';
import { adminRateLimiter } from '../../plugins/redis.plugin';
import { notFound } from '../../../utils/http-error';
import type { Platform, SourceType, DownloadMethod, UploadMode } from '../../../types/platforms.js';
import { SOURCE_TYPES, DOWNLOAD_METHODS, PLATFORM_VALUES, DOWNLOAD_METHODS_VALUES, SOURCE_TYPES_VALUES, UPLOAD_MODE_VALUES, UPLOAD_MODES } from '../../../types/platforms.js';
import { ensureVodDownload, findVodRecord } from './utils/vod-helpers.js';
import { queueYoutubeUploads } from '../../../workers/jobs/youtube.job';
import { createAutoLogger } from '../../../utils/auto-tenant-logger';

interface ReUploadYoutubeParams {
  tenantId: string;
}

interface ReUploadYoutubeBody {
  vodId: string;
  platform: Platform;
  downloadMethod?: DownloadMethod;
  uploadMode?: UploadMode;
  type: SourceType;
}

export default async function youtubeUploadRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  if (!adminRateLimiter) {
    throw new Error('Rate limiter not initialized');
  }

  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: adminRateLimiter });

  // Manually trigger YouTube re-upload for a VOD
  fastify.post<{ Params: ReUploadYoutubeParams; Body: ReUploadYoutubeBody }>(
    '/vods/re-upload-youtube',
    {
      schema: {
        tags: ['Admin'],
        description: 'Manually trigger YouTube re-upload for a VOD',
        params: { type: 'object', properties: { tenantId: { type: 'string', description: 'Tenant ID' } }, required: ['tenantId'] },
        body: {
          type: 'object',
          properties: {
            vodId: { type: 'string', description: 'Platform VOD ID' },
            platform: { type: 'string', enum: PLATFORM_VALUES, description: 'Source platform' },
            downloadMethod: { type: 'string', enum: DOWNLOAD_METHODS_VALUES, default: DOWNLOAD_METHODS.HLS, description: 'Download method' },
            uploadMode: { type: 'string', enum: UPLOAD_MODE_VALUES, default: UPLOAD_MODES.ALL },
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
      const { tenantId, platform, db } = request.tenant as TenantPlatformContext;
      const { vodId, type, downloadMethod, uploadMode } = request.body;
      const log = createAutoLogger(tenantId);

      // Ensure VOD record exists or create it from platform API metadata
      const vodRecord = await findVodRecord(db, vodId, platform);

      if (!vodRecord) {
        notFound(`VOD ${vodId} not found on ${platform}`);
      }

      const dbId = vodRecord.id;

      // Ensure vod download
      const { jobId, filePath } = await ensureVodDownload({ ctx: request.tenant as TenantPlatformContext, dbId, vodId, type, downloadMethod, log });

      // Queue Youtube upload
      await queueYoutubeUploads({
        ctx: request.tenant as TenantPlatformContext,
        dbId,
        vodId,
        filePath,
        platform,
        uploadMode,
        downloadJobId: jobId ?? undefined,
      });

      if (jobId) {
        return {
          data: {
            message: 'VOD download queued, YouTube upload will be triggered after completion',
            dbId: vodRecord.id,
            vodId: vodRecord.vod_id,
            jobId,
          },
        };
      } else {
        return {
          data: {
            message: 'Youtube upload queued!',
            filePath,
          },
        };
      }
    }
  );

  return fastify;
}
