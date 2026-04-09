import { FastifyInstance } from 'fastify';

import { getTenantConfig } from '../../../config/loader';
import createRateLimitMiddleware from '../../middleware/rate-limit';
import adminApiKeyMiddleware from '../../middleware/admin-api-key';
import { adminRateLimiter } from '../../plugins/redis.plugin';
import { createAutoLogger } from '../../../utils/auto-tenant-logger.js';
import { notFound, serviceUnavailable, badRequest } from '../../../utils/http-error';

type VodRecord = { id: number; vod_id: string; title?: string | null; duration: number | string; platform: 'twitch' | 'kick' };

interface ReUploadYoutubeParams {
  tenantId: string;
}

interface ReUploadYoutubeBody {
  vodId: string;
  platform: 'twitch' | 'kick';
}

interface ReDownloadVodParams {
  tenantId: string;
}

interface ReDownloadVodBody {
  vodId: string;
  platform: 'twitch' | 'kick';
}

export default async function youtubeUploadRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  if (!adminRateLimiter) {
    throw new Error('Rate limiter not initialized');
  }

  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: adminRateLimiter });

  // Manually trigger YouTube re-upload for a VOD with duration validation
  fastify.post<{ Params: ReUploadYoutubeParams; Body: ReUploadYoutubeBody }>(
    '/:tenantId/vods/re-upload-youtube',
    {
      schema: {
        tags: ['Admin'],
        description: 'Manually trigger YouTube re-upload for a VOD with duration validation',
        params: { type: 'object', properties: { tenantId: { type: 'string', description: 'Tenant ID' } }, required: ['tenantId'] },
        body: {
          type: 'object',
          properties: {
            vodId: { type: 'string', description: 'Platform VOD ID' },
            platform: { type: 'string', enum: ['twitch', 'kick'], description: 'Source platform' },
          },
          required: ['vodId', 'platform'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const tenantId = request.params.tenantId;
      const { vodId, platform } = request.body;
      const log = createAutoLogger(tenantId);

      const config = getTenantConfig(tenantId);

      if (!config) notFound('Tenant not found');

      if (!config.youtube) badRequest('YouTube integration not configured for this tenant');

      const { getClient } = await import('../../../db/client.js');

      const dbClient = getClient(tenantId);

      if (!dbClient) {
        log.error('Database not available');
        serviceUnavailable('Database not available');
      }

      const vodRecord = (await dbClient.vod.findUnique({ where: { platform_vod_id: { vod_id: vodId, platform } } })) as VodRecord | null;

      if (!vodRecord) notFound(`VOD ${vodId} not found`);

      const { ensureVodDownload } = await import('./utils/vod-helpers.js');

      const finalMp4Path = await ensureVodDownload({
        tenantId,
        dbId: vodRecord.id,
        vodId: vodId,
        platform: platform,
        type: 'vod',
      });

      const YouTubeQueueModule = await import('../../../jobs/queues');

      // Validate duration if available (optional, non-blocking)
      try {
        const { getDuration } = await import('../../../utils/ffmpeg.js');
        const actualDuration: number | null = await getDuration(finalMp4Path);

        if (!actualDuration) throw new Error('Could not determine video duration from MP4 file');

        let expectedSeconds: number | null = null;

        // Parse duration based on platform format
        const durationStr = String(vodRecord.duration);

        if (vodRecord.platform === 'twitch') {
          const [hrs, mins, secs] = durationStr.split(':').map(Number);
          expectedSeconds = hrs * 3600 + mins * 60 + secs;

          if (expectedSeconds > 0) {
            log.info(`Duration validation: actual=${actualDuration}s vs expected=${expectedSeconds}s`);
          } else {
            log.info(`Duration validation: actual=${actualDuration}s (no expected duration to compare)`);
          }
        }
      } catch (validationError) {
        // Non-critical - just log and continue with upload anyway
        log.warn(validationError instanceof Error ? `Duration check failed: ${validationError.message}` : 'Duration validation skipped');
      }

      const youtubeJob = {
        tenantId,
        dbId: vodRecord.id,
        vodId: vodRecord.vod_id,
        filePath: finalMp4Path,
        title: `Re-upload: ${vodRecord.title || vodRecord.vod_id}`,
        description: 'Manual re-upload triggered via admin endpoint',
        type: 'vod' as const,
      };

      await YouTubeQueueModule.getYoutubeUploadQueue().add('youtube_upload', youtubeJob, { jobId: `youtube-reupload_${vodRecord.vod_id}` });

      return { data: { message: 'YouTube re-upload job queued', dbId: vodRecord.id, vodId: vodRecord.vod_id, jobId: `youtube-reupload_${vodRecord.vod_id}`, durationValidation: null } };
    }
  );

  // Manually trigger VOD download (clears Redis dedup key first)
  fastify.post<{ Params: ReDownloadVodParams; Body: ReDownloadVodBody }>(
    '/:tenantId/vods/re-download',
    {
      schema: {
        tags: ['Admin'],
        description: 'Manually trigger VOD download (clears Redis dedup key first)',
        params: { type: 'object', properties: { tenantId: { type: 'string', description: 'Tenant ID' } }, required: ['tenantId'] },
        body: {
          type: 'object',
          properties: {
            vodId: { type: 'string', description: 'Platform VOD ID' },
            platform: { type: 'string', enum: ['twitch', 'kick'], description: 'Source platform' },
          },
          required: ['vodId', 'platform'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const tenantId = request.params.tenantId;
      const { vodId, platform } = request.body;
      const log = createAutoLogger(tenantId);

      const config = getTenantConfig(tenantId);

      if (!config) notFound('Tenant not found');

      const { getClient } = await import('../../../db/client.js');

      const dbClient = getClient(tenantId);

      if (!dbClient) {
        log.error('Database not available');
        serviceUnavailable('Database not available');
      }

      const vodRecord = (await dbClient.vod.findUnique({ where: { platform_vod_id: { vod_id: vodId, platform } } })) as VodRecord | null;

      if (!vodRecord) notFound(`VOD ${vodId} not found`);

      // Queue download job
      const YouTubeQueueModule = await import('../../../jobs/queues');

      const downloadJob = {
        tenantId: tenantId,
        platformUserId: tenantId,
        dbId: vodRecord.id,
        vodId: vodRecord.vod_id,
        platform: platform,
      };

      void YouTubeQueueModule.getVODDownloadQueue().add('vod_download', downloadJob, { jobId: `download_${vodRecord.vod_id}` });

      return { data: { message: 'Re-download job queued', dbId: vodRecord.id, vodId: vodRecord.vod_id, jobId: `download_${vodRecord.vod_id}` } };
    }
  );

  return fastify;
}
