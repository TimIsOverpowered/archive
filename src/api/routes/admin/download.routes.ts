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
import { badRequest, internalServerError, notFound } from '../../../utils/http-error.ts';
import { triggerVodBackfill } from '../../../workers/jobs/backfill.job.ts';
import adminApiKeyMiddleware from '../../middleware/admin-api-key.ts';
import {
  asTenantPlatformContext,
  platformValidationMiddleware,
  requireTenant,
  tenantMiddleware,
} from '../../middleware/tenant-platform.ts';
import { ok } from '../../response.ts';
import { ensureVodDownload } from './utils/vod-downloads.ts';
import { buildVodJobResponse } from './utils/vod-job-response.ts';
import { processVodDownloadAndUpload } from './utils/vod-pipeline.ts';

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

/** Body for the backfill endpoint (platform-driven bulk download). */
interface BackfillBody {
  platform: Platform;
}

/**
 * Register download job routes: upload (create + download + queue), re-download.
 * Requires admin API key authentication and tenant middleware.
 */
export default function downloadJobsRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
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
      onRequest: [adminApiKeyMiddleware, tenantMiddleware],
      preValidation: [platformValidationMiddleware],
    },
    async (request) => {
      const tenantCtx = asTenantPlatformContext(requireTenant(request));
      const { tenantId, platform } = tenantCtx;
      const { vodId, type, downloadMethod, uploadMode } = request.body;
      const log = createAutoLogger(tenantId);

      const result = await processVodDownloadAndUpload(
        tenantCtx,
        vodId,
        { type, uploadMode, downloadMethod, skipFinalize: true },
        log
      );

      if (result == null) {
        notFound(`VOD ${vodId} not found on ${platform}`);
      }

      return buildVodJobResponse({
        hasDownload: result.jobId != null,
        filePath: result.filePath,
        downstreamJobId: result.jobId ?? '',
        downstreamLabel: 'YouTube upload',
        copyJobId: result.copyJobId,
        base: result.jobId != null ? { dbId: result.dbId, vodId: result.platformVodId, jobId: result.jobId } : {},
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
      onRequest: [adminApiKeyMiddleware, tenantMiddleware],
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
      const { jobId, filePath, copyJobId } = await ensureVodDownload({
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
      } else if (copyJobId != null && copyJobId !== '') {
        return ok({
          message: 'File copy queued!',
          dbId,
          vodId,
          copyJobId,
        });
      } else {
        badRequest(`File already exists at ${filePath}`);
      }
    }
  );

  // Backfill: enqueue a background job that fetches the streamer's full VOD list
  // from the platform (oldest first) and queues a download + YouTube upload for
  // each VOD that isn't already downloaded and uploaded. Downloads run
  // sequentially, oldest first. Returns immediately so large libraries don't
  // time out the request.
  fastify.post<{ Params: Params; Body: BackfillBody }>(
    '/vods/backfill',
    {
      schema: {
        tags: ['Admin'],
        description:
          "Queue a bulk backfill of a streamer's archived VODs (oldest first) — downloads + YouTube uploads are queued by a background worker",
        params: {
          type: 'object',
          properties: { tenantId: { type: 'string', description: 'Tenant ID' } },
          required: ['tenantId'],
        },
        body: {
          type: 'object',
          properties: {
            platform: { type: 'string', enum: PLATFORM_VALUES, description: 'Source platform' },
          },
          required: ['platform'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, tenantMiddleware],
      preValidation: [platformValidationMiddleware],
    },
    async (request, reply) => {
      const tenantCtx = asTenantPlatformContext(requireTenant(request));
      const { tenantId, platform } = tenantCtx;

      const result = await triggerVodBackfill({ tenantId, platform });
      if (result == null) {
        internalServerError('Failed to queue VOD backfill');
      }

      reply.code(202);
      return ok({
        message: result.isNew ? 'VOD backfill queued' : 'VOD backfill already queued',
        platform,
        jobId: result.jobId,
        alreadyQueued: !result.isNew,
      });
    }
  );

  return fastify;
}
