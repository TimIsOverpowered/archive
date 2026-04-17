import { FastifyInstance } from 'fastify';
import createRateLimitMiddleware from '../../middleware/rate-limit.js';
import adminApiKeyMiddleware from '../../middleware/admin-api-key.js';
import {
  tenantMiddleware,
  platformValidationMiddleware,
  type TenantPlatformContext,
} from '../../middleware/tenant-platform.js';
import { ensureVodDownload, ensureVodRecord, findVodRecord } from './utils/vod-helpers.js';
import { adminRateLimiter } from '../../plugins/redis.plugin.js';
import { createAutoLogger } from '../../../utils/auto-tenant-logger.js';
import { badRequest, notFound } from '../../../utils/http-error.js';
import type { Platform, SourceType, DownloadMethod, UploadMode } from '../../../types/platforms.js';
import {
  SOURCE_TYPES,
  DOWNLOAD_METHODS,
  UPLOAD_MODES,
  PLATFORM_VALUES,
  UPLOAD_MODE_VALUES,
  DOWNLOAD_METHODS_VALUES,
  SOURCE_TYPES_VALUES,
} from '../../../types/platforms.js';
import { queueYoutubeUploads } from '../../../workers/jobs/youtube.job';

interface Params {
  tenantId: string;
}

interface ReDownloadVodBody {
  vodId: string;
  platform: Platform;
  downloadMethod?: DownloadMethod;
  type: SourceType;
}

interface UploadBody {
  vodId: string;
  type: SourceType;
  platform: Platform;
  uploadMode: UploadMode;
  downloadMethod: DownloadMethod;
}

export default async function downloadJobsRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  if (!adminRateLimiter) {
    throw new Error('Rate limiter not initialized');
  }

  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: adminRateLimiter });

  // Main download endpoint - creates VOD record if missing, then queues download + emote + chat jobs + upload (Twitch/Kick)
  fastify.post<{ Body: UploadBody; Params: Params }>(
    '/upload',
    {
      schema: {
        tags: ['Admin'],
        description: 'Create VOD record if missing, then queue download + emote + chat jobs (Twitch/Kick)',
        params: {
          type: 'object',
          properties: { tenantId: { type: 'string', minLength: 1, maxLength: 100, description: 'Tenant ID' } },
          required: ['tenantId'],
        },
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
      const { tenantId, platform } = request.tenant as TenantPlatformContext;
      const { vodId, type, downloadMethod, uploadMode } = request.body;
      const log = createAutoLogger(tenantId);

      // Ensure VOD record exists or create it from platform API metadata
      const vodRecord = await ensureVodRecord(request.tenant as TenantPlatformContext, vodId, log);

      if (!vodRecord) {
        notFound(`VOD ${vodId} not found on ${platform}`);
      }

      const dbId = vodRecord.id;

      // Ensure vod download
      const { jobId, filePath } = await ensureVodDownload({
        ctx: request.tenant as TenantPlatformContext,
        dbId,
        vodId,
        type,
        downloadMethod,
        log,
      });

      // Queue Youtube upload
      await queueYoutubeUploads({
        ctx: request.tenant as TenantPlatformContext,
        dbId,
        vodId,
        filePath,
        platform,
        uploadMode,
        downloadJobId: jobId ?? undefined,
        type,
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

  // Manually trigger VOD download
  fastify.post<{ Params: Params; Body: ReDownloadVodBody }>(
    '/vods/re-download',
    {
      schema: {
        tags: ['Admin'],
        description: 'Manually trigger VOD download',
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
      const { tenantId, platform, db } = request.tenant as TenantPlatformContext;
      const { vodId, type, downloadMethod } = request.body;
      const log = createAutoLogger(tenantId);

      // Ensure VOD record exists
      const vodRecord = await findVodRecord(db, vodId, platform);

      if (!vodRecord) {
        notFound(`VOD ${vodId} not found on ${platform}`);
      }

      const dbId = vodRecord.id;

      // Ensure vod download
      const { jobId, filePath } = await ensureVodDownload({
        ctx: request.tenant as TenantPlatformContext,
        dbId,
        vodId,
        type,
        downloadMethod,
        log,
      });

      if (jobId) {
        return {
          data: {
            message: 'VOD download queued!',
            dbId,
            vodId,
            jobId,
          },
        };
      } else {
        return badRequest(`File already exists at ${filePath}`);
      }
    }
  );

  return fastify;
}
