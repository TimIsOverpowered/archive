import { FastifyInstance } from 'fastify';
import { findVodByPlatformId } from '../../../db/queries/vods.js';
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
import { createAutoLogger } from '../../../utils/auto-tenant-logger.js';
import { notFound, badRequest } from '../../../utils/http-error.js';
import { queueYoutubeUploads } from '../../../workers/jobs/youtube.job.js';
import adminApiKeyMiddleware from '../../middleware/admin-api-key.js';
import createRateLimitMiddleware from '../../middleware/rate-limit.js';
import {
  tenantMiddleware,
  platformValidationMiddleware,
  asTenantPlatformContext,
  requireTenant,
} from '../../middleware/tenant-platform.js';
import { ok } from '../../response.js';
import { ensureVodDownload } from './utils/vod-downloads.js';
import { buildVodJobResponse } from './utils/vod-job-response.js';
import { findOrCreateVodRecord } from './utils/vod-records.js';

/** Route params for download job endpoints. */
interface Params {
  tenantId: string;
}

/** Body for manually re-triggering a VOD download. */
interface ReDownloadVodBody {
  vodId: string;
  platform: Platform;
  downloadMethod?: DownloadMethod;
  type: SourceType;
}

/** Body for the main upload endpoint (create VOD + queue download + YouTube upload). */
interface UploadBody {
  vodId: string;
  type: SourceType;
  platform: Platform;
  uploadMode: UploadMode;
  downloadMethod: DownloadMethod;
}

/**
 * Register download job routes: upload (create + download + queue), re-download.
 * Requires admin API key authentication, tenant middleware, and rate limiting.
 */
export default function downloadJobsRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: fastify.adminRateLimiter });

  // Main download endpoint - creates VOD record if missing, then queues download + emote + chat jobs + upload (Twitch/Kick)
  fastify.post<{ Body: UploadBody; Params: Params }>(
    '/vods/upload',
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
      const tenantCtx = asTenantPlatformContext(requireTenant(request));
      const { tenantId, platform } = tenantCtx;
      const { vodId, type, downloadMethod, uploadMode } = request.body;
      const log = createAutoLogger(tenantId);

      const vodRecord = await findOrCreateVodRecord(tenantCtx, vodId, log);

      if (!vodRecord) {
        notFound(`VOD ${vodId} not found on ${platform}`);
      }

      const dbId = vodRecord.id;

      const { jobId, filePath, workDir } = await ensureVodDownload({
        ctx: tenantCtx,
        dbId,
        vodId,
        type,
        downloadMethod,
        log,
      });
      await queueYoutubeUploads({
        ctx: tenantCtx,
        dbId,
        vodId,
        filePath,
        platform,
        uploadMode,
        downloadJobId: jobId ?? undefined,
        type,
        workDir,
      });
      return buildVodJobResponse({
        hasDownload: jobId != null,
        filePath,
        downstreamJobId: jobId ?? '',
        downstreamLabel: 'YouTube upload',
        base: jobId != null ? { dbId: vodRecord.id, vodId: vodRecord.platform_vod_id, jobId } : {},
      });
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
      const tenantCtx = asTenantPlatformContext(requireTenant(request));
      const { tenantId, platform, db } = tenantCtx;
      const { vodId, type, downloadMethod } = request.body;
      const log = createAutoLogger(tenantId);

      // Ensure VOD record exists
      const vodRecord = await findVodByPlatformId(db, vodId, platform);

      if (!vodRecord) {
        notFound(`VOD ${vodId} not found on ${platform}`);
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

      if (jobId != null) {
        return ok({
          message: 'VOD download queued!',
          dbId,
          vodId,
          jobId,
        });
      } else {
        badRequest(`File already exists at ${filePath}`);
      }
    }
  );

  return fastify;
}
