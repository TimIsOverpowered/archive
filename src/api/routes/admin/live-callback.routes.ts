import type { FastifyInstance } from 'fastify';
import { extractErrorDetails } from '../../../utils/error.js';
import fs from 'fs/promises';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { getStreamerConfig } from '../../../config/loader';
import createRateLimitMiddleware from '../../middleware/rate-limit';
import type { PrismaClient } from '../../../../generated/streamer/client';
import type { VodRecordBase } from './types';
import { enqueueJobWithLogging } from '../../../jobs/queues.js';
import { fileExists } from '../../../utils/path.js';

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

type LiveCallbackParams = { id: string };

interface LiveCallbackResponseData {
  message: string;
  vodId: string;
  jobId?: string | undefined;
  path: string;
}

export default async function liveCallbackRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: fastify.adminRateLimiter });

  // Callback endpoint for twitch-recorder-go when live stream recording completes
  fastify.route<{ Params: LiveCallbackParams; Body: LiveCallbackBody }>({
    method: 'POST',
    url: '/:id/live',
    schema: {
      tags: ['Admin'],
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
      security: [{ apiKey: [] }],
    },
    onRequest: rateLimitMiddleware,
    handler: async (request) => {
      const streamerId = request.params.id;

      try {
        // Validate tenant exists
        const config = getStreamerConfig(streamerId);

        if (!config) {
          throw new Error('Tenant not found');
        }

        // Validate platform is enabled for this tenant
        if (request.body.platform === 'twitch' && !config.twitch?.enabled) {
          throw new Error('Twitch is not enabled for this tenant');
        }

        if (request.body.platform === 'kick' && !config.kick?.enabled) {
          throw new Error('Kick is not enabled for this tenant');
        }

        // Validate file path exists and is accessible
        try {
          const exists = await fileExists(request.body.path);

          if (!exists) {
            throw new Error(`File at ${request.body.path} does not exist`);
          }

          const stats = await fs.stat(request.body.path);
          if (!stats.isFile() || stats.size === 0) {
            throw new Error(`File at ${request.body.path} is invalid (not a regular file or empty)`);
          }

          request.log.info(`[${streamerId}] Validated recording file: ${request.body.path} (${(stats.size / (1024 * 1024)).toFixed(2)} MB)`);
        } catch (accessError) {
          const errorMessage = accessError instanceof Error ? accessError.message : String(accessError);
          request.log.error(`[${streamerId}] File validation failed for ${request.body.path}: ${errorMessage}`);

          throw new Error('Recording file not found or inaccessible');
        }

        // Get database client
        let client: PrismaClient;
        try {
          const ClientModule = await import('../../../db/client');
          const retrievedClient = ClientModule.getClient(streamerId);

          if (!retrievedClient) {
            throw new Error('Database not available for tenant');
          }

          client = retrievedClient;
        } catch (error: unknown) {
          const details = extractErrorDetails(error);
          request.log.error({ ...details, streamerId }, `[${streamerId}] Database error`);
          throw new Error('Database connection failed');
        }

        // Look up VOD record by stream_id or id
        let vodRecord: VodRecordBase | null = await client.vod.findFirst({
          where: {
            OR: [{ id: request.body.streamId }, { stream_id: request.body.streamId }],
          },
        });

        if (!vodRecord) {
          // VOD doesn't exist - create placeholder for live recording callback
          request.log.warn(`[${streamerId}] No VOD record found for ${request.body.streamId}. Creating placeholder...`);

          vodRecord = await client.vod.create({
            data: {
              id: request.body.streamId,
              platform: request.body.platform,
              title: `${request.body.platform.toUpperCase()} Live Recording`,
              duration: request.body.durationSecs || 0,
              stream_id: request.body.streamId,
            },
          });

          request.log.info(`[${streamerId}] Created placeholder VOD ${request.body.streamId}`);
        } else if (vodRecord.platform !== request.body.platform) {
          request.log.warn(`[${streamerId}] Platform mismatch for VOD ${request.body.streamId}: expected=${request.body.platform}, actual=${vodRecord.platform}`);
        }

        // Update duration if provided and different from current value
        if (request.body.durationSecs && vodRecord.duration !== request.body.durationSecs) {
          await client.vod.update({
            where: { id: vodRecord.id },
            data: { duration: request.body.durationSecs },
          });

          request.log.info(`[${streamerId}] Updated VOD ${vodRecord.id} duration to ${request.body.durationSecs}s`);
        } else if (!request.body.durationSecs && vodRecord.duration === 0) {
          // Duration not provided and current is 0 - try to get from file metadata or skip update
          request.log.debug(`[${streamerId}] No duration update needed for VOD ${vodRecord.id}`);
        }

        // Queue YouTube upload job for the pre-recorded MP4 file at `path`
        const YoutubeQueueModule = await import('../../../jobs/queues');

        if (!config.youtube?.liveUpload) {
          request.log.warn(`[${streamerId}] YouTube live upload not enabled, skipping queue for ${request.body.streamId}`);

          return <{ data: LiveCallbackResponseData }>{
            data: {
              message: 'YouTube live upload is disabled for this tenant. Recording processed but no upload queued.',
              vodId: request.body.streamId,
              path: request.body.path,
            },
          };
        }

        const youtubeJobData = {
          streamerId,
          vodId: request.body.streamId,
          filePath: request.body.path, // Pre-recorded MP4 path from recorder
          title: vodRecord.title || `${request.body.platform.toUpperCase()} VOD`,
          description: config.youtube.description || '',
          type: 'live' as const, // Special live upload type (no splitting/trimming)
          platform: request.body.platform,
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const queue = YoutubeQueueModule.getYoutubeUploadQueue() as any;
        const { jobId, isNew } = await enqueueJobWithLogging(
          queue,
          'youtube_upload',
          youtubeJobData,
          {
            jobId: `youtube-live:${request.body.streamId}`,
            deduplication: { id: `youtube-live:${request.body.streamId}` },
          },
          { info: request.log.info.bind(request.log), debug: request.log.debug.bind(request.log) },
          `[${streamerId}] Queued YouTube upload job for live recording`,
          { vodId: request.body.streamId, path: request.body.path }
        );

        if (isNew) {
          request.log.debug({ vodId: request.body.streamId, jobId }, `[${streamerId}] Job was newly added to queue`);
        }

        return <{ data: LiveCallbackResponseData }>{
          data: {
            message: 'YouTube upload queued successfully',
            vodId: request.body.streamId,
            jobId,
            path: request.body.path,
          },
        };
      } catch (error) {
        const details = extractErrorDetails(error);
        const errorMsg = details.message;

        // Only throw if not already a proper HTTP error response scenario
        request.log.error(`[${streamerId}] Live callback failed for ${request.body.streamId}: ${errorMsg}`);

        throw new Error('Failed to process live recording callback');
      }
    },
  });

  return fastify;
}
