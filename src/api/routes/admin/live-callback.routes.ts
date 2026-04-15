import type { FastifyInstance } from 'fastify';
import fs from 'fs/promises';
import createRateLimitMiddleware from '../../middleware/rate-limit';
import adminApiKeyMiddleware from '../../middleware/admin-api-key';
import { tenantMiddleware, platformValidationMiddleware, type TenantPlatformContext } from '../../middleware/tenant-platform';
import { fileExists } from '../../../utils/path.js';
import { adminRateLimiter } from '../../plugins/redis.plugin';
import { createAutoLogger } from '../../../utils/auto-tenant-logger.js';
import { notFound, badRequest } from '../../../utils/http-error';
import type { Platform } from '../../../types/platforms.js';
import { PLATFORM_VALUES } from '../../../types/platforms.js';
import { findStreamRecord } from './utils/vod-helpers';
import { queueYoutubeUploads } from '../../../workers/jobs/youtube.job';

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
          platform: { type: 'string', enum: PLATFORM_VALUES, description: 'Source platform' },
        },
        required: ['streamId', 'path', 'platform'],
      },
      security: [{ apiKey: [] }],
    },
    onRequest: [adminApiKeyMiddleware, rateLimitMiddleware, tenantMiddleware],
    preValidation: [platformValidationMiddleware],
    handler: async (request) => {
      const { tenantId, config, db, platform } = request.tenant as TenantPlatformContext;
      const log = createAutoLogger(tenantId);

      // Validate file path exists and is accessible
      try {
        const exists = await fileExists(request.body.path);

        if (!exists) {
          badRequest(`File at ${request.body.path} does not exist`);
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

      const vodRecord = await findStreamRecord(db, request.body.streamId, platform);
      if (!vodRecord) notFound(`VOD ${request.body.streamId} not found`);

      // Update duration if provided and different from current value
      if (request.body.durationSecs && vodRecord.duration !== request.body.durationSecs) {
        await db.vod.update({
          where: { id: vodRecord.id },
          data: { duration: request.body.durationSecs },
        });

        log.info(`Updated VOD ${vodRecord.id} duration to ${request.body.durationSecs}s`);
      } else if (!request.body.durationSecs && vodRecord.duration === 0) {
        // Duration not provided and current is 0 - try to get from file metadata or skip update
        log.debug(`No duration update needed for VOD ${vodRecord.id}`);
      }

      if (!config?.youtube?.upload) {
        log.warn(`YouTube upload not enabled, skipping queue for ${request.body.streamId}`);

        return <{ data: LiveCallbackResponseData }>{
          data: {
            message: 'YouTube upload is disabled for this tenant. Recording processed but no upload queued.',
            vodId: streamIdNum,
            path: request.body.path,
          },
        };
      }

      queueYoutubeUploads({ ctx: request.tenant as TenantPlatformContext, dbId: vodRecord.id, vodId: vodRecord.vod_id, filePath: request.body.path, platform, log });

      return <{ data: LiveCallbackResponseData }>{
        data: {
          message: 'YouTube upload queued successfully',
          vodId: streamIdNum,
          path: request.body.path,
        },
      };
    },
  });

  return fastify;
}
