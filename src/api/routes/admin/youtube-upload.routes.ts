import { FastifyInstance } from 'fastify';
import createRateLimitMiddleware from '../../middleware/rate-limit.js';
import adminApiKeyMiddleware from '../../middleware/admin-api-key.js';
import {
  tenantMiddleware,
  platformValidationMiddleware,
  asTenantPlatformContext,
  requireTenant,
} from '../../middleware/tenant-platform.js';
import { RedisService } from '../../../utils/redis-service.js';
import { HttpError } from '../../../utils/http-error.js';
import type { Platform, SourceType, DownloadMethod, UploadMode } from '../../../types/platforms.js';
import {
  SOURCE_TYPES,
  DOWNLOAD_METHODS,
  PLATFORM_VALUES,
  DOWNLOAD_METHODS_VALUES,
  SOURCE_TYPES_VALUES,
  UPLOAD_MODE_VALUES,
  UPLOAD_MODES,
} from '../../../types/platforms.js';
import { ensureVodDownload, findVodRecord } from './utils/vod-helpers.js';
import { queueYoutubeUploads } from '../../../workers/jobs/youtube.job.js';
import { createAutoLogger } from '../../../utils/auto-tenant-logger.js';
/** Route params for YouTube re-upload endpoint. */
interface ReUploadYoutubeParams {
  tenantId: string;
}

/** Body for triggering YouTube re-upload for a VOD. */
interface ReUploadYoutubeBody {
  vodId: string;
  platform: Platform;
  downloadMethod?: DownloadMethod;
  uploadMode?: UploadMode;
  type: SourceType;
}

/**
 * Register YouTube upload routes: re-upload a VOD to YouTube.
 * Requires admin API key authentication, tenant middleware, and rate limiting.
 */
export default function youtubeUploadRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  const adminRateLimiter = RedisService.getLimiter('rate:admin');
  if (!adminRateLimiter) {
    throw new Error('Rate limiter not initialized');
  }

  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: adminRateLimiter });

  // Manually trigger YouTube re-upload for a VOD
  fastify.post<{ Params: ReUploadYoutubeParams; Body: ReUploadYoutubeBody }>(
    '/vods/re-upload',
    {
      schema: {
        tags: ['Admin'],
        description: 'Manually trigger YouTube re-upload for a VOD',
        params: {
          type: 'object',
          properties: { tenantId: { type: 'string', description: 'Tenant ID' } },
          required: ['tenantId'],
        },
        body: {
          type: 'object',
          properties: {
            vodId: { type: 'string', description: 'Platform VOD ID' },
            platform: { type: 'string', enum: PLATFORM_VALUES, description: 'Source platform' },
            downloadMethod: {
              type: 'string',
              enum: DOWNLOAD_METHODS_VALUES,
              default: DOWNLOAD_METHODS.HLS,
              description: 'Download method',
            },
            uploadMode: { type: 'string', enum: UPLOAD_MODE_VALUES, default: UPLOAD_MODES.ALL },
            type: {
              type: 'string',
              enum: SOURCE_TYPES_VALUES,
              default: SOURCE_TYPES.VOD,
              description: 'File type for checking',
            },
          },
          required: ['vodId', 'platform'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware, tenantMiddleware],
      preValidation: [platformValidationMiddleware],
    },
    async (request) => {
      const tenantCtx = asTenantPlatformContext(requireTenant(request));
      const { tenantId, platform, db } = tenantCtx;
      const { vodId, type, downloadMethod, uploadMode } = request.body;
      const log = createAutoLogger(tenantId);

      // Ensure VOD record exists or create it from platform API metadata
      const vodRecord = await findVodRecord(db, vodId, platform);

      if (!vodRecord) {
        throw new HttpError(404, `VOD ${vodId} not found on ${platform}`, 'NOT_FOUND');
      }

      const dbId = vodRecord.id;

      // Ensure vod download
      const { jobId, filePath } = await ensureVodDownload({
        ctx: tenantCtx,
        dbId,
        vodId,
        type,
        downloadMethod,
        log,
      });

      // Queue Youtube upload
      await queueYoutubeUploads({
        ctx: tenantCtx,
        dbId,
        vodId,
        filePath,
        platform,
        uploadMode,
        downloadJobId: jobId ?? undefined,
        type,
      });

      if (jobId != null) {
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
