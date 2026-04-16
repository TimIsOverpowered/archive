import { FastifyInstance } from 'fastify';
import createRateLimitMiddleware from '../../middleware/rate-limit.js';
import adminApiKeyMiddleware from '../../middleware/admin-api-key.js';
import { tenantMiddleware, platformValidationMiddleware, type TenantPlatformContext } from '../../middleware/tenant-platform.js';
import { adminRateLimiter } from '../../plugins/redis.plugin.js';
import { createAutoLogger } from '../../../utils/auto-tenant-logger.js';
import { notFound } from '../../../utils/http-error.js';
import type { Platform, SourceType, DownloadMethod } from '../../../types/platforms.js';
import { PLATFORM_VALUES, SOURCE_TYPES, SOURCE_TYPES_VALUES, DOWNLOAD_METHODS_VALUES, DOWNLOAD_METHODS } from '../../../types/platforms.js';
import { findVodRecord, ensureVodDownload } from './utils/vod-helpers.js';
import { queueDmcaProcessing } from '../../../workers/jobs/dmca.job.js';

interface DmcaClaim {
  type?: string;
  reason?: string;
  url?: string;
  [key: string]: unknown;
}

interface DmcaRequestBody {
  vodId: string;
  claims: DmcaClaim[] | string;
  platform: Platform;
  type?: SourceType;
  part?: number;
  downloadMethod?: DownloadMethod;
}

export default async function dmcaProcessingRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  if (!adminRateLimiter) {
    throw new Error('Rate limiter not initialized');
  }

  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: adminRateLimiter });

  // Main DMCA endpoint - ensure VOD download, then queue DMCA processing
  fastify.post<{ Body: DmcaRequestBody; Params: { tenantId: string } }>(
    '/dmca',
    {
      schema: {
        tags: ['Admin'],
        description: 'Ensure VOD download, then queue DMCA processing (mutes audio/blackouts video based on claims). If part is provided, only that part is processed and uploaded.',
        params: { type: 'object', properties: { tenantId: { type: 'string', description: 'Tenant ID' } }, required: ['tenantId'] },
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
            type: { type: 'string', enum: SOURCE_TYPES_VALUES },
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
      const { tenantId, db, platform } = request.tenant as TenantPlatformContext;
      const { vodId, claims, type = SOURCE_TYPES.VOD, part, downloadMethod = DOWNLOAD_METHODS.HLS } = request.body;
      const log = createAutoLogger(tenantId);

      // Step 1: Ensure VOD record exists
      const vodRecord = await findVodRecord(db, vodId, platform);
      if (!vodRecord) notFound('VOD not found');

      // Step 2: Ensure VOD download (like /upload does)
      const { jobId: downloadJobId, filePath } = await ensureVodDownload({
        ctx: request.tenant as TenantPlatformContext,
        dbId: vodRecord.id,
        vodId,
        type,
        downloadMethod,
        log,
      });

      // Step 3: Parse claims (lenient - no validation)
      const claimsArray = Array.isArray(claims) ? claims : JSON.parse(typeof claims === 'string' ? claims : JSON.stringify(claims));

      // Step 4: Queue DMCA processing (chained to download if needed)
      const dmcaJobId = await queueDmcaProcessing({
        tenantId,
        dbId: vodRecord.id,
        vodId: String(vodRecord.vod_id),
        claims: claimsArray,
        type,
        platform,
        part,
        downloadJobId: downloadJobId ?? undefined,
      });

      if (!dmcaJobId) {
        throw new Error('Failed to queue DMCA processing job');
      }

      // Step 5: Return appropriate response
      if (downloadJobId) {
        const context = { vodId, downloadJobId, dmcaJobId, part, claimsCount: claimsArray.length };
        log.info(context, 'VOD download queued, DMCA processing will be triggered after completion');
        return {
          data: {
            message: 'VOD download queued, DMCA processing will be triggered after completion',
            dbId: vodRecord.id,
            vodId: vodRecord.vod_id,
            downloadJobId,
            dmcaJobId,
            ...(part !== undefined && { part }),
          },
        };
      } else {
        const context = { vodId, dmcaJobId, filePath, part, claimsCount: claimsArray.length };
        log.info(context, 'DMCA processing queued');
        return {
          data: {
            message: 'DMCA processing queued!',
            dbId: vodRecord.id,
            vodId: vodRecord.vod_id,
            dmcaJobId,
            filePath,
            ...(part !== undefined && { part }),
          },
        };
      }
    }
  );

  return fastify;
}
