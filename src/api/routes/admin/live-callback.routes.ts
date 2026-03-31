import { FastifyInstance } from 'fastify';
import fs from 'fs/promises';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { getStreamerConfig } from '../../../config/loader';
import createRateLimitMiddleware from '../../middleware/rate-limit';

declare module 'fastify' {
  interface FastifyInstance {
    adminRateLimiter: RateLimiterRedis;
  }
}

interface LiveCallbackBody {
  streamId: string;
  path: string;
  durationSecs?: number;
  platform: 'twitch' | 'kick';
}

export default async function liveCallbackRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: fastify.adminRateLimiter });

  // Callback endpoint for twitch-recorder-go when live stream recording completes
  fastify.post(
    '/:id/live',
    {
      schema: {
        tags: ['Admin', 'Live Recording'],
        description: 'Callback from external recorder when live HLS download/merge completes. Queues YouTube upload.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          properties: {
            streamId: { type: 'string', description: 'VOD/Stream ID' },
            path: { type: 'string', description: 'Local filesystem path to recorded MP4 file' },
            durationSecs: { type: 'number', description: 'Duration in seconds (optional)' },
            platform: { type: 'string', enum: ['twitch', 'kick'] },
          },
          required: ['streamId', 'path', 'platform'],
        },
      },
      onRequest: rateLimitMiddleware,
    },
    async (request: any) => {
      const streamerId = request.params.id;
      const body: LiveCallbackBody = request.body;

      try {
        // Validate tenant exists
        const config = getStreamerConfig(streamerId);

        if (!config) {
          throw new Error('Tenant not found');
        }

        // Validate platform is enabled for this tenant
        if (body.platform === 'twitch' && !config.twitch?.enabled) {
          throw new Error('Twitch is not enabled for this tenant');
        }

        if (body.platform === 'kick' && !config.kick?.enabled) {
          throw new Error('Kick is not enabled for this tenant');
        }

        // Validate file path exists and is accessible
        try {
          await fs.access(body.path);

          const stats = await fs.stat(body.path);
          if (!stats.isFile() || stats.size === 0) {
            throw new Error(`File at ${body.path} is invalid (not a regular file or empty)`);
          }

          request.log.info(`[${streamerId}] Validated recording file: ${body.path} (${(stats.size / (1024 * 1024)).toFixed(2)} MB)`);
        } catch (accessError) {
          const errorMessage = accessError instanceof Error ? accessError.message : String(accessError);
          request.log.error(`[${streamerId}] File validation failed for ${body.path}: ${errorMessage}`);

          throw new Error('Recording file not found or inaccessible');
        }

        // Get database client
        let client: any;
        try {
          const ClientModule = await import('../../../db/client');
          client = ClientModule.getClient(streamerId);

          if (!client) {
            throw new Error('Database not available for tenant');
          }
        } catch (error: any) {
          request.log.error(`[${streamerId}] Database error: ${error.message}`);
          throw new Error('Database connection failed');
        }

        // Look up VOD record by stream_id or id
        let vodRecord: any = await client.vod.findFirst({
          where: {
            OR: [{ id: body.streamId }, { stream_id: body.streamId }],
          },
        });

        if (!vodRecord) {
          // VOD doesn't exist - create placeholder for live recording callback
          request.log.warn(`[${streamerId}] No VOD record found for ${body.streamId}. Creating placeholder...`);

          vodRecord = await client.vod.create({
            data: {
              id: body.streamId,
              platform: body.platform,
              title: `${body.platform.toUpperCase()} Live Recording`,
              duration: body.durationSecs || 0,
              stream_id: body.streamId,
            },
          });

          request.log.info(`[${streamerId}] Created placeholder VOD ${body.streamId}`);
        } else if (vodRecord.platform !== body.platform) {
          request.log.warn(`[${streamerId}] Platform mismatch for VOD ${body.streamId}: expected=${body.platform}, actual=${vodRecord.platform}`);
        }

        // Update duration if provided and different from current value
        if (body.durationSecs && vodRecord.duration !== body.durationSecs) {
          await client.vod.update({
            where: { id: vodRecord.id },
            data: { duration: body.durationSecs },
          });

          request.log.info(`[${streamerId}] Updated VOD ${vodRecord.id} duration to ${body.durationSecs}s`);
        } else if (!body.durationSecs && vodRecord.duration === 0) {
          // Duration not provided and current is 0 - try to get from file metadata or skip update
          request.log.debug(`[${streamerId}] No duration update needed for VOD ${vodRecord.id}`);
        }

        // Queue YouTube upload job for the pre-recorded MP4 file at `path`
        const YoutubeQueueModule = await import('../../../jobs/queues');

        if (!config.youtube?.liveUpload) {
          request.log.warn(`[${streamerId}] YouTube live upload not enabled, skipping queue for ${body.streamId}`);

          return {
            data: {
              message: 'YouTube live upload is disabled for this tenant. Recording processed but no upload queued.',
              vodId: body.streamId,
              path: body.path,
            },
          };
        }

        const youtubeJobData = {
          streamerId,
          vodId: body.streamId,
          filePath: body.path, // Pre-recorded MP4 path from recorder
          title: vodRecord.title || `${body.platform.toUpperCase()} VOD`,
          description: config.youtube.description || '',
          type: 'live' as const, // Special live upload type (no splitting/trimming)
          platform: body.platform,
        };

        const job = await (YoutubeQueueModule.getYoutubeUploadQueue() as any).add(youtubeJobData, {
          name: 'youtube_upload',
          id: `youtube-live:${body.streamId}:${Date.now()}`,
        });

        request.log.info(`[${streamerId}] Queued YouTube upload job ${job.id} for live recording at ${body.path}`);

        return {
          data: {
            message: 'YouTube upload queued successfully',
            vodId: body.streamId,
            jobId: String(job.id),
            path: body.path,
          },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);

        // Only throw if not already a proper HTTP error response scenario
        request.log.error(`[${streamerId}] Live callback failed for ${body?.streamId}: ${errorMsg}`);

        throw new Error('Failed to process live recording callback');
      }
    }
  );

  return fastify;
}
