import type { FastifyInstance } from 'fastify';
import { findVodByPlatformId } from '../../../db/queries/vods.ts';
import type { DownloadMethod, Platform, SourceType, UploadMode } from '../../../types/platforms.ts';
import {
  DOWNLOAD_METHODS,
  DOWNLOAD_METHODS_VALUES,
  PLATFORM_VALUES,
  SOURCE_TYPES,
  SOURCE_TYPES_VALUES,
  UPLOAD_MODE_VALUES,
  UPLOAD_MODES,
} from '../../../types/platforms.ts';
import { createAutoLogger } from '../../../utils/auto-tenant-logger.ts';
import { notFound } from '../../../utils/http-error.ts';
import { queueYoutubeUploads } from '../../../workers/jobs/youtube.job.ts';
import adminApiKeyMiddleware from '../../middleware/admin-api-key.ts';
import {
  asTenantPlatformContext,
  platformValidationMiddleware,
  requireTenant,
  tenantMiddleware,
} from '../../middleware/tenant-platform.ts';
import { ensureVodDownload } from './utils/vod-downloads.ts';
import { buildVodJobResponse } from './utils/vod-job-response.ts';

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
 * Requires admin API key authentication and tenant middleware.
 */
export default function youtubeUploadRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
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
      onRequest: [adminApiKeyMiddleware, tenantMiddleware],
      preValidation: [platformValidationMiddleware],
    },
    async (request) => {
      const tenantCtx = asTenantPlatformContext(requireTenant(request));
      const { tenantId, platform, db } = tenantCtx;
      const { vodId, type, downloadMethod, uploadMode } = request.body;
      const log = createAutoLogger(tenantId);

      // Ensure VOD record exists or create it from platform API metadata
      const vodRecord = await findVodByPlatformId(db, vodId, platform);

      if (!vodRecord) {
        notFound(`VOD ${vodId} not found on ${platform}`);
      }

      const dbId = vodRecord.id;

      // Ensure vod download
      const { jobId, filePath, copyJobId, workDir, copiedFromStorage } = await ensureVodDownload({
        ctx: tenantCtx,
        dbId,
        vodId,
        type,
        downloadMethod,
        log,
        skipFinalize: true,
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
        copyJobId,
        type,
        workDir,
        forceUpload: true,
        copiedFromStorage,
      });

      return buildVodJobResponse({
        hasDownload: jobId != null,
        filePath,
        downstreamJobId: jobId ?? '',
        downstreamLabel: 'YouTube upload',
        copyJobId,
        base: jobId != null ? { dbId: vodRecord.id, vodId: vodRecord.platform_vod_id, jobId } : {},
      });
    }
  );

  return fastify;
}
