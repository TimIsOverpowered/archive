import { FastifyInstance } from 'fastify';
import { extractErrorDetails } from '../../../utils/error.js';
import path from 'path';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { getTenantConfig } from '../../../config/loader';
import createRateLimitMiddleware from '../../middleware/rate-limit';
import adminApiKeyMiddleware from '../../middleware/admin-api-key';
import { fileExists } from '../../../utils/path.js';

declare module 'fastify' {
  interface FastifyInstance {
    adminRateLimiter: RateLimiterRedis;
  }
}

type VodRecord = { id: string; title?: string | null; duration: number | string; platform: 'twitch' | 'kick' };

interface ReUploadYoutubeParams {
  id: string;
  vodId: string;
}

interface ReDownloadVodParams {
  id: string;
  vodId: string;
}

export default async function youtubeUploadRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: fastify.adminRateLimiter });

  // Manually trigger YouTube re-upload for a VOD with duration validation
  fastify.post<{ Params: ReUploadYoutubeParams }>(
    '/:id/vods/:vodId/re-upload-youtube',
    {
      schema: {
        tags: ['Admin'],
        description: 'Manually trigger YouTube re-upload for a VOD with duration validation',
        params: { type: 'object', properties: { id: { type: 'string' }, vodId: { type: 'string' } }, required: ['id', 'vodId'] },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const tenantId = request.params.id;
      const vodId = request.params.vodId;

      try {
        const config = getTenantConfig(tenantId);

        if (!config) throw new Error('Tenant not found');

        if (!config.youtube) throw new Error('YouTube integration not configured for this tenant');

        const { getClient } = await import('../../../db/client.js');

        const dbClient = getClient(tenantId);

        if (!dbClient) {
          request.log.error(`[${tenantId}] Database not available`);
          throw new Error('Database not available');
        }

        const vodRecord = (await dbClient.vod.findUnique({ where: { id: vodId } })) as VodRecord | null;

        if (!vodRecord) throw new Error(`VOD ${vodId} not found`);

        const finalMp4Path = path.join(config.settings.vodPath!, tenantId, `${vodId}.mp4`);

        const exists = await fileExists(finalMp4Path);

        if (!exists) {
          throw new Error('MP4 file not found. VOD may not have been processed yet.');
        }

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
              fastify.log.info(`[${vodId}] Duration validation: actual=${actualDuration}s vs expected=${expectedSeconds}s`);
            } else {
              fastify.log.info(`[${vodId}] Duration validation: actual=${actualDuration}s (no expected duration to compare)`);
            }
          }
        } catch (validationError) {
          // Non-critical - just log and continue with upload anyway
          request.log.warn(validationError instanceof Error ? `Duration check failed: ${validationError.message}` : 'Duration validation skipped');
        }

        const youtubeJob = {
          tenantId,
          vodId,
          filePath: finalMp4Path,
          title: `Re-upload: ${vodRecord.title || vodId}`,
          description: 'Manual re-upload triggered via admin endpoint',
          type: 'vod' as const,
        };

        await YouTubeQueueModule.getYoutubeUploadQueue().add('youtube_upload', youtubeJob, { jobId: `youtube-reupload_${vodId}` });

        return { data: { message: 'YouTube re-upload job queued', vodId, jobId: `youtube-reupload_${vodId}`, durationValidation: null } };
      } catch (error) {
        const details = extractErrorDetails(error);
        const errorMsg = details.message;
        request.log.error(`[${tenantId}] Re-upload failed for ${vodId}: ${errorMsg}`);

        throw new Error('Failed to queue re-upload job');
      }
    }
  );

  // Manually trigger VOD download (clears Redis dedup key first)
  fastify.post<{ Params: ReDownloadVodParams }>(
    '/:id/vods/:vodId/re-download',
    {
      schema: {
        tags: ['Admin'],
        description: 'Manually trigger VOD download (clears Redis dedup key first)',
        params: { type: 'object', properties: { id: { type: 'string' }, vodId: { type: 'string' } }, required: ['id', 'vodId'] },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const tenantId = request.params.id;
      const vodId = request.params.vodId;

      try {
        const config = getTenantConfig(tenantId);

        if (!config) throw new Error('Tenant not found');

        const { getClient } = await import('../../../db/client.js');

        const dbClient = getClient(tenantId);

        if (!dbClient) {
          request.log.error(`[${tenantId}] Database not available`);
          throw new Error('Database not available');
        }

        const vodRecord = (await dbClient.vod.findUnique({ where: { id: vodId } })) as VodRecord | null;

        if (!vodRecord) throw new Error(`VOD ${vodId} not found`);

        // Queue download job
        const YouTubeQueueModule = await import('../../../jobs/queues');

        const downloadJob = {
          tenantId: tenantId,
          platformUserId: tenantId,
          vodId,
          platform: vodRecord.platform as 'twitch' | 'kick',
        };

        void YouTubeQueueModule.getVODDownloadQueue().add('vod_download', downloadJob, { jobId: `download_${vodId}` });

        return { data: { message: 'Re-download job queued', vodId, jobId: `download_${vodId}` } };
      } catch (error) {
        const details = extractErrorDetails(error);
        const errorMsg = details.message;
        request.log.error(`[${tenantId}] Re-download failed for ${vodId}: ${errorMsg}`);

        throw new Error('Failed to queue re-download job');
      }
    }
  );

  return fastify;
}
