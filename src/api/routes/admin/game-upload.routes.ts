import { FastifyInstance } from 'fastify';
import createRateLimitMiddleware from '../../middleware/rate-limit.js';
import adminApiKeyMiddleware from '../../middleware/admin-api-key.js';
import { tenantMiddleware, requireTenant, TenantPlatformContext  } from '../../middleware/tenant-platform.js';
import { RedisService } from '../../../utils/redis-service.js';
import { HttpError } from '../../../utils/http-error.js';
import type { Platform, SourceType, DownloadMethod } from '../../../types/platforms.js';
import {
  DOWNLOAD_METHODS,
  DOWNLOAD_METHODS_VALUES,
  SOURCE_TYPES,
} from '../../../types/platforms.js';
import { ensureVodDownload } from './utils/vod-helpers.js';
import { queueYoutubeGameUpload } from '../../../workers/jobs/youtube.job.js';
import { createAutoLogger } from '../../../utils/auto-tenant-logger.js';
import { GameNotFoundError } from '../../../utils/domain-errors.js';

interface ReUploadGameParams {
  tenantId: string;
}

interface ReUploadGameBody {
  gameId: number;
  downloadMethod?: DownloadMethod;
}

export default function gameUploadRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  const adminRateLimiter = RedisService.getLimiter('rate:admin');
  if (!adminRateLimiter) {
    throw new Error('Rate limiter not initialized');
  }

  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: adminRateLimiter });

  fastify.post<{ Params: ReUploadGameParams; Body: ReUploadGameBody }>(
    '/games/re-upload',
    {
      schema: {
        tags: ['Admin'],
        description: 'Manually trigger YouTube re-upload for a single game',
        params: {
          type: 'object',
          properties: { tenantId: { type: 'string', description: 'Tenant ID' } },
          required: ['tenantId'],
        },
        body: {
          type: 'object',
          properties: {
            gameId: { type: 'number', description: 'Game database ID' },
            downloadMethod: {
              type: 'string',
              enum: DOWNLOAD_METHODS_VALUES,
              default: DOWNLOAD_METHODS.HLS,
              description: 'Download method',
            },
          },
          required: ['gameId'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware, tenantMiddleware],
    },
    async (request) => {
      const tenantCtx = requireTenant(request);
      const { tenantId, config, db } = tenantCtx;
      const { gameId, downloadMethod } = request.body;
      const log = createAutoLogger(tenantId);

      // Check if game exists
      const game = await db
        .selectFrom('games')
        .selectAll()
        .where('id', '=', gameId)
        .executeTakeFirst();

      if (!game) {
        throw new GameNotFoundError(gameId);
      }

      // Look up associated VOD
      const vodRecord = await db
        .selectFrom('vods')
        .selectAll()
        .where('id', '=', game.vod_id)
        .executeTakeFirst();

      if (!vodRecord) {
        throw new HttpError(404, `VOD ${game.vod_id} not found for game ${gameId}`, 'NOT_FOUND');
      }

      const platform = vodRecord.platform as Platform;

      // Validate platform is enabled for tenant
      if (config[platform]?.enabled !== true) {
        throw new HttpError(400, `${platform} is not enabled for this tenant`, 'BAD_REQUEST');
      }

      // Build platform-aware context for downstream helpers
      const tenantPlatformCtx: TenantPlatformContext = {
        ...tenantCtx,
        platform,
      };

      const dbId = vodRecord.id;
      const vodId = vodRecord.vod_id;
      const type: SourceType = SOURCE_TYPES.VOD;

      // Ensure VOD file is downloaded and valid
      const { jobId, filePath } = await ensureVodDownload({
        ctx: tenantPlatformCtx,
        dbId,
        vodId,
        type,
        downloadMethod,
        log,
      });

      // Find matching chapter by start/end time
      const chapter = await db
        .selectFrom('chapters')
        .selectAll()
        .where('vod_id', '=', dbId)
        .where('start', '=', game.start_time)
        .where('end', '=', game.end_time)
        .executeTakeFirst();

      if (!chapter) {
        throw new HttpError(
          404,
          `No matching chapter found for game ${gameId} (start: ${game.start_time}, end: ${game.end_time})`,
          'NOT_FOUND'
        );
      }

      // Queue game upload
      const gameJobId = await queueYoutubeGameUpload(
        tenantPlatformCtx,
        dbId,
        vodId,
        filePath,
        platform,
        chapter.id,
        jobId ?? undefined
      );

      if (jobId != null) {
        return {
          data: {
            message: 'VOD download queued, game upload will be triggered after completion',
            gameId,
            vodId,
            chapterId: chapter.id,
            downloadJobId: jobId,
            gameJobId,
          },
        };
      }

      return {
        data: {
          message: 'Game upload queued',
          gameId,
          vodId,
          chapterId: chapter.id,
          filePath,
          gameJobId,
        },
      };
    }
  );

  return fastify;
}
