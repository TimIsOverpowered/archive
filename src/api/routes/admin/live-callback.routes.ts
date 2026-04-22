import type { FastifyInstance } from 'fastify';
import fs from 'fs/promises';
import type { Stats as FsStats } from 'fs';
import createRateLimitMiddleware from '../../middleware/rate-limit.js';
import adminApiKeyMiddleware from '../../middleware/admin-api-key.js';
import {
  tenantMiddleware,
  platformValidationMiddleware,
  type TenantPlatformContext,
} from '../../middleware/tenant-platform.js';
import { fileExists } from '../../../utils/path.js';
import { RedisService } from '../../../utils/redis-service.js';
import { createAutoLogger } from '../../../utils/auto-tenant-logger.js';
import { notFound, badRequest } from '../../../utils/http-error.js';
import type { Platform } from '../../../types/platforms.js';
import { PLATFORM_VALUES, SOURCE_TYPES } from '../../../types/platforms.js';
import { findStreamRecord } from './utils/vod-helpers.js';
import { queueYoutubeUploads } from '../../../workers/jobs/youtube.job';
import { VodUpdateSchema } from '../../../config/schemas.js';
import { publishVodDurationUpdate } from '../../../services/cache-invalidator.js';

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
  const adminRateLimiter = RedisService.getLimiter('rate:admin');
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
      params: {
        type: 'object',
        properties: { tenantId: { type: 'string', description: 'Tenant ID' } },
        required: ['tenantId'],
      },
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
      const exists = await fileExists(request.body.path);
      if (!exists) {
        badRequest(`File at ${request.body.path} does not exist`);
      }

      let stats: FsStats;
      try {
        stats = await fs.stat(request.body.path);
      } catch {
        notFound('Recording file not found or inaccessible');
      }
      if (!stats.isFile() || stats.size === 0) {
        badRequest(`File at ${request.body.path} is invalid (not a regular file or empty)`);
      }

      // Look up VOD record by stream_id or id
      const streamIdNum = Number(request.body.streamId);

      const vodRecord = await findStreamRecord(db, request.body.streamId, platform);
      if (!vodRecord) notFound(`VOD ${request.body.streamId} not found`);

      // Update duration if provided and different from current value
      if (request.body.durationSecs && vodRecord.duration !== request.body.durationSecs) {
        VodUpdateSchema.parse({ duration: request.body.durationSecs });
        await db
          .updateTable('vods')
          .set({ duration: request.body.durationSecs })
          .where('id', '=', vodRecord.id)
          .execute();

        await publishVodDurationUpdate(tenantId, vodRecord.id, request.body.durationSecs, vodRecord.is_live);

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

      const { gameJobIds, vodJobId } = await queueYoutubeUploads({
        ctx: request.tenant as TenantPlatformContext,
        dbId: vodRecord.id,
        vodId: vodRecord.vod_id,
        filePath: request.body.path,
        platform,
        type: SOURCE_TYPES.LIVE,
      });

      return <{ data: LiveCallbackResponseData }>{
        data: {
          message: 'YouTube upload queued successfully',
          vodId: vodRecord.id,
          streamId: streamIdNum,
          gameJobIds,
          vodJobId,
          path: request.body.path,
        },
      };
    },
  });

  return fastify;
}
