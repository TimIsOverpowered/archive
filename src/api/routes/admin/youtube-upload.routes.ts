import { FastifyInstance } from 'fastify';
import fsPromises from 'fs/promises';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import Redis from 'ioredis';
import { getStreamerConfig } from '../../../config/loader';
import createRateLimitMiddleware from '../../middleware/rate-limit';
import adminApiKeyMiddleware from '../../middleware/admin-api-key';

declare module 'fastify' {
  interface FastifyInstance {
    adminRateLimiter: RateLimiterRedis;
  }
}

export default async function youtubeUploadRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: fastify.adminRateLimiter });

  // Manually trigger YouTube re-upload for a VOD with duration validation
  fastify.post(
    '/:id/vods/:vodId/re-upload-youtube',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Manually trigger YouTube re-upload for a VOD with duration validation',
        params: { type: 'object', properties: { id: { type: 'string' }, vodId: { type: 'string' } }, required: ['id', 'vodId'] },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request: any) => {
      const streamerId = request.params.id;
      const vodId = request.params.vodId;

      try {
        const config = getStreamerConfig(streamerId);

        if (!config) throw new Error('Tenant not found');

        if (!config.youtube) throw new Error('YouTube integration not configured for this tenant');

        let client: any;

        try {
          const ClientModule = await import('../../../db/client');
          client = ClientModule.getClient(streamerId);

          if (!client) throw new Error('Database not available');
        } catch (error: any) {
          request.log.error(`[${streamerId}] Database error: ${error.message}`);
          throw new Error('Database not available');
        }

        const vodRecord: any = await client.vod.findUnique({ where: { id: vodId } });

        if (!vodRecord) throw new Error(`VOD ${vodId} not found`);

        const finalMp4Path = `${config.settings.vodPath}/${streamerId}/${vodId}.mp4`;

        try {
          await fsPromises.access(finalMp4Path);
        } catch {
          throw new Error('MP4 file not found. VOD may not have been processed yet.');
        }

        const YouTubeQueueModule = await import('../../../jobs/queues');

        // Validate duration if available (optional, non-blocking)
        try {
          const VideoValidatorModule = await import('../../../utils/video-validator');
          const actualDuration: number | null = await VideoValidatorModule.validateVideoDuration(finalMp4Path);

          if (!actualDuration) throw new Error('Could not determine video duration from MP4 file');

          let expectedSeconds: number | null = null;

          // Parse duration based on platform format
          const durationStr = vodRecord.duration as string;

          if (vodRecord.platform === 'twitch' && typeof durationStr === 'string') {
            const [hrs, mins, secs] = String(durationStr).split(':').map(Number);
            expectedSeconds = hrs * 3600 + mins * 60 + secs;

            if (expectedSeconds > 0) {
              fastify.log.info(`[${vodId}] Duration validation: actual=${actualDuration}s vs expected=${expectedSeconds}s`);
            } else {
              fastify.log.info(`[${vodId}] Duration validation: actual=${actualDuration}s (no expected duration to compare)`);
            }
          }
        } catch (validationError) {
          // Non-critical - just log and continue with upload anyway
          request.warn?.(validationError instanceof Error ? `Duration check failed: ${validationError.message}` : 'Duration validation skipped');
        }

        const youtubeJob = {
          streamerId,
          vodId,
          filePath: finalMp4Path,
          title: `Re-upload: ${vodRecord.title || vodId}`,
          description: 'Manual re-upload triggered via admin endpoint',
          type: 'vod' as const,
        };

        await (YouTubeQueueModule.getYoutubeUploadQueue() as any).add(youtubeJob, { id: `youtube-reupload:${vodId}:${Date.now()}` });

        return { data: { message: 'YouTube re-upload job queued', vodId, jobId: `youtube-reupload:${vodId}:${Date.now()}`, durationValidation: null } };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        request.log.error(`[${streamerId}] Re-upload failed for ${vodId}: ${errorMsg}`);

        throw new Error('Failed to queue re-upload job');
      }
    }
  );

  // Manually trigger VOD download (clears Redis dedup key first)
  fastify.post(
    '/:id/vods/:vodId/re-download',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Manually trigger VOD download (clears Redis dedup key first)',
        params: { type: 'object', properties: { id: { type: 'string' }, vodId: { type: 'string' } }, required: ['id', 'vodId'] },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request: any) => {
      const streamerId = request.params.id;
      const vodId = request.params.vodId;

      try {
        const config = getStreamerConfig(streamerId);

        if (!config) throw new Error('Tenant not found');

        let client: any;

        try {
          const ClientModule = await import('../../../db/client');
          client = ClientModule.getClient(streamerId);

          if (!client) throw new Error('Database not available');
        } catch (error: any) {
          request.log.error(`[${streamerId}] Database error: ${error.message}`);
          throw new Error('Database not available');
        }

        const vodRecord: any = await client.vod.findUnique({ where: { id: vodId } });

        if (!vodRecord) throw new Error(`VOD ${vodId} not found`);

        // Clear Redis dedup key to allow re-download
        try {
          const redisInstance = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

          await redisInstance.del(`vod_download:${vodId}`);

          request.log.info(`[${streamerId}] Cleared Redis dedup key for manual re-download of ${vodId}`);
        } catch (err) {
          const errStr = err instanceof Error ? err.message : String(err);
          request.log.warn(`Failed to clear dedup key: ${errStr}`);
        }

        // Queue download job
        const YouTubeQueueModule = await import('../../../jobs/queues');

        const downloadJob = {
          streamerId,
          vodId,
          platform: vodRecord.platform as 'twitch' | 'kick',
          userId: streamerId,
        };

        await (YouTubeQueueModule.getVODDownloadQueue() as any).add(downloadJob, { name: 'vod_download', id: `download:${vodId}:${Date.now()}` });

        return { data: { message: 'Re-download job queued', vodId, jobId: `download:${vodId}:${Date.now()}` } };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        request.log.error(`[${streamerId}] Re-download failed for ${vodId}: ${errorMsg}`);

        throw new Error('Failed to queue re-download job');
      }
    }
  );

  return fastify;
}
