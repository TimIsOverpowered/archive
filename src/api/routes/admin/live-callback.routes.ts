import type { FastifyInstance } from 'fastify';
import fs from 'fs/promises';
import type { Stats as FsStats } from 'fs';
import createRateLimitMiddleware from '../../middleware/rate-limit.js';
import adminApiKeyMiddleware from '../../middleware/admin-api-key.js';
import {
  tenantMiddleware,
  platformValidationMiddleware,
  asTenantPlatformContext,
} from '../../middleware/tenant-platform.js';
import { fileExists } from '../../../utils/path.js';
import { RedisService } from '../../../utils/redis-service.js';
import { createAutoLogger } from '../../../utils/auto-tenant-logger.js';
import { notFound, badRequest } from '../../../utils/http-error.js';
import type { Platform } from '../../../types/platforms.js';
import { PLATFORM_VALUES, SOURCE_TYPES } from '../../../types/platforms.js';
import { findStreamRecord } from './utils/vod-helpers.js';
import { queueYoutubeUploads } from '../../../workers/jobs/youtube.job.js';
import { VodUpdateSchema } from '../../../config/schemas.js';
import { publishVodDurationUpdate } from '../../../services/cache-invalidator.js';

/** Body of the live callback from external recorder. */
interface LiveCallbackBody {
  streamId: string;
  path: string;
  durationSecs?: number;
  platform: Platform;
}

/** Route params for the live callback endpoint. */
type LiveCallbackParams = { tenantId: string };

/** Response payload for the live callback endpoint. */
interface LiveCallbackResponseData {
  message: string;
  vodId: number;
  streamId: string;
  jobId?: string | undefined;
  path: string;
}

/**
 * Register live callback routes: handle recording completion webhook from twitch-recorder-go.
 * Validates recording file, updates duration, queues YouTube upload.
 */
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
      const { tenantId, config, db, platform } = asTenantPlatformContext(request.tenant);
      const { streamId, path, durationSecs } = request.body;
      const log = createAutoLogger(tenantId);

      // Validate file path exists and is accessible
      const exists = await fileExists(path);
      if (!exists) {
        throw badRequest(`File at ${path} does not exist`);
      }

      let stats: FsStats;
      try {
        stats = await fs.stat(path);
      } catch {
        throw notFound('Recording file not found or inaccessible');
      }
      if (!stats.isFile() || stats.size === 0) {
        throw badRequest(`File at ${path} is invalid (not a regular file or empty)`);
      }

      const vodRecord = await findStreamRecord(db, streamId, platform);
      if (!vodRecord) throw notFound(`VOD ${streamId} not found`);

      // Update duration if provided and different from current value
      if (durationSecs && vodRecord.duration !== durationSecs) {
        VodUpdateSchema.parse({ duration: durationSecs });
        await db.updateTable('vods').set({ duration: durationSecs }).where('id', '=', vodRecord.id).execute();

        await publishVodDurationUpdate(tenantId, vodRecord.id, durationSecs, vodRecord.is_live);

        log.info(`Updated VOD ${vodRecord.id} duration to ${durationSecs}s`);
      }

      if (!config?.youtube?.upload) {
        log.warn(`YouTube upload not enabled, skipping queue for ${streamId}`);

        return <{ data: LiveCallbackResponseData }>{
          data: {
            message: 'YouTube upload is disabled for this tenant. Recording processed but no upload queued.',
            vodId: vodRecord.id,
            streamId,
            path: path,
          },
        };
      }

      const { gameJobIds, vodJobId } = await queueYoutubeUploads({
        ctx: asTenantPlatformContext(request.tenant),
        dbId: vodRecord.id,
        vodId: vodRecord.vod_id,
        filePath: path,
        platform,
        type: SOURCE_TYPES.LIVE,
      });

      return <{ data: LiveCallbackResponseData }>{
        data: {
          message: 'YouTube upload queued successfully',
          vodId: vodRecord.id,
          streamId,
          gameJobIds,
          vodJobId,
          path: path,
        },
      };
    },
  });

  return fastify;
}
