import { FastifyInstance } from 'fastify';
import { findVodByPlatformId } from '../../../db/queries/vods.js';
import type { Platform, SourceType, DownloadMethod } from '../../../types/platforms.js';
import {
  PLATFORM_VALUES,
  SOURCE_TYPES,
  SOURCE_TYPES_VALUES,
  DOWNLOAD_METHODS_VALUES,
  DOWNLOAD_METHODS,
} from '../../../types/platforms.js';
import { createAutoLogger } from '../../../utils/auto-tenant-logger.js';
import { notFound, internalServerError } from '../../../utils/http-error.js';
import { queueDmcaProcessing } from '../../../workers/jobs/dmca.job.js';
import adminApiKeyMiddleware from '../../middleware/admin-api-key.js';
import createRateLimitMiddleware from '../../middleware/rate-limit.js';
import {
  tenantMiddleware,
  platformValidationMiddleware,
  asTenantPlatformContext,
  requireTenant,
} from '../../middleware/tenant-platform.js';
import { parseDmcaClaims } from './utils/dmca.js';
import { ensureVodDownload } from './utils/vod-downloads.js';
import { buildVodJobResponse } from './utils/vod-job-response.js';

/** DMCA claim entry with optional typed fields. */
interface DmcaClaim {
  type?: string;
  reason?: string;
  url?: string;
  [key: string]: unknown;
}

/** Body for the DMCA processing endpoint. */
interface DmcaRequestBody {
  vodId: string;
  claims: DmcaClaim[] | string;
  platform: Platform;
  type?: SourceType;
  part?: number;
  downloadMethod?: DownloadMethod;
}

/**
 * Register DMCA processing routes: ensure VOD download, queue DMCA processing job.
 * Requires admin API key authentication, tenant middleware, and rate limiting.
 */
export default function dmcaProcessingRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: fastify.adminRateLimiter });

  // Main DMCA endpoint - ensure VOD download, then queue DMCA processing
  fastify.post<{ Body: DmcaRequestBody; Params: { tenantId: string } }>(
    '/vods/dmca',
    {
      schema: {
        tags: ['Admin'],
        description:
          'Ensure VOD download, then queue DMCA processing (mutes audio/blackouts video based on claims). If part is provided, only that part is processed and uploaded.',
        params: {
          type: 'object',
          properties: { tenantId: { type: 'string', description: 'Tenant ID' } },
          required: ['tenantId'],
        },
        body: {
          type: 'object',
          properties: {
            vodId: { type: 'string', description: 'Platform VOD ID' },
            claims: { description: 'DMCA claims array or JSON string' },
            part: {
              type: 'number',
              minimum: 1,
              description: 'Optional part number (1-indexed) to process only a specific part of the VOD',
            },
            platform: { type: 'string', enum: PLATFORM_VALUES, description: 'Source platform' },
            type: { type: 'string', enum: SOURCE_TYPES_VALUES, default: SOURCE_TYPES.VOD },
            downloadMethod: {
              type: 'string',
              enum: DOWNLOAD_METHODS_VALUES,
              default: DOWNLOAD_METHODS.HLS,
              description: 'Download method for VOD',
            },
          },
          required: ['vodId', 'claims', 'platform'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware, tenantMiddleware],
      preValidation: [platformValidationMiddleware],
    },
    async (request) => {
      const { tenantId, db, platform } = asTenantPlatformContext(requireTenant(request));
      const { vodId, claims, type = SOURCE_TYPES.VOD, part, downloadMethod = DOWNLOAD_METHODS.HLS } = request.body;
      const log = createAutoLogger(tenantId);

      // Step 1: Ensure VOD record exists
      const vodRecord = await findVodByPlatformId(db, vodId, platform);
      if (!vodRecord) notFound('VOD not found');

      // Step 2: Ensure VOD download (like /upload does)
      const { jobId: downloadJobId, filePath } = await ensureVodDownload({
        ctx: asTenantPlatformContext(requireTenant(request)),
        dbId: vodRecord.id,
        vodId,
        type,
        downloadMethod,
        log,
      });

      // Step 3: Parse claims (lenient - no validation)
      const claimsArray = parseDmcaClaims(claims);

      // Step 4: Queue DMCA processing (chained to download if needed)
      const dmcaJobId = await queueDmcaProcessing({
        tenantId,
        dbId: vodRecord.id,
        vodId: vodRecord.platform_vod_id ?? '',
        claims: claimsArray,
        type,
        platform,
        part,
        downloadJobId: downloadJobId ?? undefined,
        filePath,
      });

      if (dmcaJobId == null) {
        return internalServerError('Failed to queue DMCA processing job');
      }

      // Step 5: Return appropriate response
      if (downloadJobId != null) {
        const context = { vodId, downloadJobId, dmcaJobId, part, claimsCount: claimsArray.length };
        log.info(context, 'VOD download queued, DMCA processing will be triggered after completion');
      } else {
        const context = { vodId, dmcaJobId, filePath, part, claimsCount: claimsArray.length };
        log.info(context, 'DMCA processing queued');
      }
      return buildVodJobResponse({
        hasDownload: downloadJobId != null,
        filePath,
        downstreamJobId: dmcaJobId,
        downstreamLabel: 'DMCA processing',
        base: { dbId: vodRecord.id, vodId: vodRecord.platform_vod_id },
        extra: part !== undefined ? { part } : {},
      });
    }
  );

  return fastify;
}
