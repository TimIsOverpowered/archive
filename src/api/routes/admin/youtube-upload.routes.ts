import { FastifyInstance } from 'fastify';
import createRateLimitMiddleware from '../../middleware/rate-limit';
import adminApiKeyMiddleware from '../../middleware/admin-api-key';
import { tenantMiddleware, platformValidationMiddleware, type TenantPlatformContext } from '../../middleware/tenant-platform';
import { adminRateLimiter } from '../../plugins/redis.plugin';
import { notFound, badRequest } from '../../../utils/http-error';
import type { Platform, SourceType, DownloadMethod } from '../../../types/platforms.js';
import { PLATFORMS, SOURCE_TYPES, DOWNLOAD_METHODS, UPLOAD_MODES } from '../../../types/platforms.js';

interface ReUploadYoutubeParams {
  tenantId: string;
}

interface ReUploadYoutubeBody {
  vodId: string;
  platform: Platform;
  downloadMethod?: DownloadMethod;
  type?: SourceType;
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
            platform: { type: 'string', enum: Object.values(PLATFORMS), description: 'Source platform' },
            downloadMethod: { type: 'string', enum: Object.values(DOWNLOAD_METHODS), default: DOWNLOAD_METHODS.HLS, description: 'Download method' },
            type: { type: 'string', enum: Object.values(SOURCE_TYPES), default: SOURCE_TYPES.VOD, description: 'File type for checking' },
          },
          required: ['vodId', 'platform'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware, tenantMiddleware],
      preValidation: [platformValidationMiddleware],
    },
    async (request) => {
      const { tenantId, config, client, platform } = request.tenant as TenantPlatformContext;
      const { vodId, downloadMethod, type } = request.body;

      if (!config?.youtube) badRequest('YouTube integration not configured for this tenant');

      const { findVodRecord } = await import('./utils/vod-helpers.js');

      const vodRecord = await findVodRecord(client, vodId, platform);

      if (!vodRecord) notFound(`VOD ${vodId} not found`);

      const VodQueueModule = await import('../../../workers/jobs/queues');

      const fileIdentifier = type === SOURCE_TYPES.LIVE ? vodRecord.stream_id || vodRecord.vod_id : vodRecord.vod_id;

      const downloadJob = {
        tenantId,
        platformUserId: tenantId,
        dbId: vodRecord.id,
        vodId: fileIdentifier,
        platform,
        uploadMode: UPLOAD_MODES.VOD,
        downloadMethod: downloadMethod || DOWNLOAD_METHODS.HLS,
      };

      const downloadJobId = `download_${vodRecord.vod_id}`;

      void VodQueueModule.getStandardVodQueue().add('standard_vod_download', downloadJob, { jobId: downloadJobId });

      return { data: { message: 'VOD download queued, YouTube upload will be triggered after completion', dbId: vodRecord.id, vodId: vodRecord.vod_id, downloadJobId } };
    }
  );

  return fastify;
}
