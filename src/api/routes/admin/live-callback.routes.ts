import type { Stats as FsStats } from 'node:fs';
import fs from 'node:fs/promises';
import * as pathModule from 'node:path';
import type { FastifyInstance } from 'fastify';
import { getLivePath, getTmpPath, getVodPath } from '../../../config/env.js';
import { VodUpdateSchema } from '../../../config/schemas.js';
import { findVodByStreamId } from '../../../db/queries/vods.js';
import { publishVodDurationUpdate } from '../../../services/cache-invalidator.js';
import type { Platform } from '../../../types/platforms.js';
import { PLATFORM_VALUES, SOURCE_TYPES } from '../../../types/platforms.js';
import { createAutoLogger } from '../../../utils/auto-tenant-logger.js';
import { badRequest, notFound } from '../../../utils/http-error.js';
import { assertPathWithinBase, fileExists, sanitizePathForLog } from '../../../utils/path.js';
import { enqueueFinalizeJob, queueYoutubeUploads } from '../../../workers/jobs/youtube.job.js';
import adminApiKeyMiddleware from '../../middleware/admin-api-key.js';
import createRateLimitMiddleware from '../../middleware/rate-limit.js';
import {
  tenantMiddleware,
  platformValidationMiddleware,
  asTenantPlatformContext,
  requireTenant,
} from '../../middleware/tenant-platform.js';
import { ok } from '../../response.js';

/** Body of the live callback from external recorder. */
interface LiveCallbackBody {
  streamId: string;
  path: string;
  durationSecs?: number;
  platform: Platform;
}

/** Route params for the live callback endpoint. */
type LiveCallbackParams = { tenantId: string };

/**
 * Register live callback routes: handle recording completion webhook from twitch-recorder-go.
 * Validates recording file, updates duration, queues YouTube upload.
 */
export default function liveCallbackRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: fastify.adminRateLimiter });

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
      const tenantCtx = asTenantPlatformContext(requireTenant(request));
      const { tenantId, config, db, platform } = tenantCtx;
      const { streamId, path: inputPath, durationSecs } = request.body;
      const log = createAutoLogger(tenantId);

      // Validate the path is within any configured storage directory
      const allowedPaths = [getLivePath(), getVodPath(), getTmpPath()].filter((p): p is string => Boolean(p));
      if (allowedPaths.length > 0) {
        try {
          assertPathWithinBase(inputPath, allowedPaths);
        } catch {
          badRequest('Invalid recording path: must be within LIVE_PATH, VOD_PATH, or TMP_PATH');
        }
      }

      // Validate file path exists and is accessible
      const exists = await fileExists(inputPath);
      if (!exists) {
        badRequest(`Recording file does not exist`);
      }

      let stats: FsStats;
      try {
        stats = await fs.stat(inputPath);
      } catch {
        notFound('Recording file not found or inaccessible');
      }
      if (!stats.isFile() || stats.size === 0) {
        badRequest(`Recording file is invalid (not a regular file or empty)`);
      }

      const vodRecord = await findVodByStreamId(db, streamId, platform);
      if (!vodRecord) notFound(`VOD ${streamId} not found`);

      // Update duration if provided and different from current value
      if (durationSecs !== undefined && vodRecord.duration !== durationSecs) {
        VodUpdateSchema.parse({ duration: durationSecs });
        await db.updateTable('vods').set({ duration: durationSecs }).where('id', '=', vodRecord.id).execute();

        await publishVodDurationUpdate(tenantId, vodRecord.id, durationSecs, vodRecord.is_live);

        log.info({ vodId: vodRecord.id, durationSecs }, 'Updated VOD duration');
      }

      if (config?.youtube?.upload === true) {
        const { gameJobIds, vodJobId } = await queueYoutubeUploads({
          ctx: tenantCtx,
          dbId: vodRecord.id,
          vodId: vodRecord.platform_vod_id ?? '',
          filePath: inputPath,
          platform,
          type: SOURCE_TYPES.LIVE,
          workDir: pathModule.dirname(inputPath),
          streamId: vodRecord.platform_stream_id ?? undefined,
          forceUpload: true,
        });

        return ok({
          message: 'YouTube upload queued successfully',
          vodId: vodRecord.id,
          streamId,
          gameJobIds,
          vodJobId,
          path: sanitizePathForLog(inputPath),
        });
      }

      const finalizeJobId = await enqueueFinalizeJob(
        tenantCtx,
        vodRecord.id,
        vodRecord.platform_vod_id ?? '',
        inputPath,
        SOURCE_TYPES.LIVE,
        platform,
        { workDir: pathModule.dirname(inputPath), streamId: vodRecord.platform_stream_id ?? undefined }
      );

      return ok({
        message: 'YouTube upload is disabled. VOD finalized to storage.',
        vodId: vodRecord.id,
        streamId,
        finalizeJobId,
        path: sanitizePathForLog(inputPath),
      });
    },
  });

  return fastify;
}
