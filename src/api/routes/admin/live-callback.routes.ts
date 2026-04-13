import type { FastifyInstance } from 'fastify';

import fs from 'fs/promises';
import createRateLimitMiddleware from '../../middleware/rate-limit';
import adminApiKeyMiddleware from '../../middleware/admin-api-key';
import { tenantMiddleware, platformValidationMiddleware, type TenantPlatformContext } from '../../middleware/tenant-platform';
import type { VodRecordBase } from './types';
import { enqueueJobWithLogging } from '../../../workers/jobs/queues.js';
import { fileExists } from '../../../utils/path.js';
import { adminRateLimiter } from '../../plugins/redis.plugin';
import { createAutoLogger } from '../../../utils/auto-tenant-logger.js';
import { notFound, badRequest } from '../../../utils/http-error';
import type { Platform } from '../../../types/platforms.js';
import { SOURCE_TYPES } from '../../../types/platforms.js';

interface LiveCallbackBody {
  streamId: string;
  path: string;
  durationSecs?: number;
  platform: Platform;
}

type LiveCallbackParams = { tenantId: string };

interface LiveCallbackResponseData {
  message: string;
  vodId: number;
  jobId?: string | undefined;
  path: string;
}

export default async function liveCallbackRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  if (!adminRateLimiter) {
    throw new Error('Rate limiter not initialized');
  }

  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: adminRateLimiter });

  // Callback endpoint for twitch-recorder-go when live stream recording completes
  fastify.route<{ Params: LiveCallbackParams; Body: LiveCallbackBody }>({
    method: 'POST',
    url: '/live',
    schema: {
      tags: ['Admin'],
      description: 'Callback from external recorder when live HLS download/merge completes. Queues YouTube upload.',
      params: { type: 'object', properties: { tenantId: { type: 'string', description: 'Tenant ID' } }, required: ['tenantId'] },
      body: {
        type: 'object',
        properties: {
          streamId: { type: 'string', description: 'VOD/Stream ID' },
          path: { type: 'string', description: 'Local filesystem path to recorded MP4 file' },
          durationSecs: { type: 'number', description: 'Duration in seconds (optional)' },
          platform: { type: 'string', enum: ['twitch', 'kick'], description: 'Source platform' },
        },
        required: ['streamId', 'path', 'platform'],
      },
      security: [{ apiKey: [] }],
    },
    onRequest: [adminApiKeyMiddleware, rateLimitMiddleware, tenantMiddleware],
    preValidation: [platformValidationMiddleware],
    handler: async (request) => {
      const { tenantId, config, client, platform } = request.tenant as TenantPlatformContext;
      const log = createAutoLogger(tenantId);

      // Validate file path exists and is accessible
      try {
        const exists = await fileExists(request.body.path);

        if (!exists) {
          notFound(`File at ${request.body.path} does not exist`);
        }

        const stats = await fs.stat(request.body.path);
        if (!stats.isFile() || stats.size === 0) {
          badRequest(`File at ${request.body.path} is invalid (not a regular file or empty)`);
        }

        log.info(`Validated recording file: ${request.body.path} (${(stats.size / (1024 * 1024)).toFixed(2)} MB)`);
      } catch (accessError) {
        const errorMessage = accessError instanceof Error ? accessError.message : String(accessError);
        log.error(`File validation failed for ${request.body.path}: ${errorMessage}`);

        notFound('Recording file not found or inaccessible');
      }

      // Look up VOD record by stream_id or id
      const streamIdNum = Number(request.body.streamId);

      let vodRecord: VodRecordBase | null = await client.vod.findFirst({
        where: {
          OR: [{ id: streamIdNum }, { stream_id: request.body.streamId }],
        },
      });

      if (!vodRecord) {
        // VOD doesn't exist - create placeholder for live recording callback
        log.warn(`No VOD record found for ${request.body.streamId}. Creating placeholder...`);

        vodRecord = await client.vod.create({
          data: {
            id: streamIdNum,
            vod_id: request.body.streamId,
            platform,
            title: `${platform.toUpperCase()} Live Recording`,
            duration: request.body.durationSecs || 0,
            stream_id: request.body.streamId,
          },
        });

        log.info(`Created placeholder VOD ${request.body.streamId}`);
      } else if (vodRecord.platform !== platform) {
        log.warn(`Platform mismatch for VOD ${request.body.streamId}: expected=${platform}, actual=${vodRecord.platform}`);
      }

      // Update duration if provided and different from current value
      if (request.body.durationSecs && vodRecord.duration !== request.body.durationSecs) {
        await client.vod.update({
          where: { id: vodRecord.id },
          data: { duration: request.body.durationSecs },
        });

        log.info(`Updated VOD ${vodRecord.id} duration to ${request.body.durationSecs}s`);
      } else if (!request.body.durationSecs && vodRecord.duration === 0) {
        // Duration not provided and current is 0 - try to get from file metadata or skip update
        log.debug(`No duration update needed for VOD ${vodRecord.id}`);
      }

      // Queue YouTube upload job for the pre-recorded MP4 file at `path`
      const YoutubeQueueModule = await import('../../../workers/jobs/queues');

      if (!config?.youtube?.liveUpload) {
        log.warn(`YouTube live upload not enabled, skipping queue for ${request.body.streamId}`);

        return <{ data: LiveCallbackResponseData }>{
          data: {
            message: 'YouTube live upload is disabled for this tenant. Recording processed but no upload queued.',
            vodId: streamIdNum,
            path: request.body.path,
          },
        };
      }

      const youtubeJobData = {
        tenantId,
        vodId: String(streamIdNum),
        filePath: request.body.path,
        title: vodRecord.title || `${platform.toUpperCase()} VOD`,
        description: config?.youtube.description || '',
        type: SOURCE_TYPES.LIVE,
        platform,
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
        { info: log.info.bind(log), debug: log.debug.bind(log) },
        'Queued YouTube upload job for live recording',
        { vodId: request.body.streamId, path: request.body.path }
      );

      if (isNew) {
        log.debug({ vodId: request.body.streamId, jobId }, 'Job was newly added to queue');
      }

      return <{ data: LiveCallbackResponseData }>{
        data: {
          message: 'YouTube upload queued successfully',
          vodId: streamIdNum,
          jobId,
          path: request.body.path,
        },
      };
    },
  });

  return fastify;
}
