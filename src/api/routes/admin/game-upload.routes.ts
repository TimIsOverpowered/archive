import { FastifyInstance } from 'fastify';
import createRateLimitMiddleware from '../../middleware/rate-limit.js';
import adminApiKeyMiddleware from '../../middleware/admin-api-key.js';
import { tenantMiddleware, requireTenant, TenantPlatformContext } from '../../middleware/tenant-platform.js';
import { RedisService } from '../../../utils/redis-service.js';
import { HttpError } from '../../../utils/http-error.js';
import type { Platform, SourceType, DownloadMethod } from '../../../types/platforms.js';
import { DOWNLOAD_METHODS, DOWNLOAD_METHODS_VALUES, SOURCE_TYPES } from '../../../types/platforms.js';
import { ensureVodDownload } from './utils/vod-helpers.js';
import { queueYoutubeGameUploadByGame } from '../../../workers/jobs/youtube.job.js';
import { queueDmcaProcessing } from '../../../workers/jobs/dmca.job.js';
import { createAutoLogger } from '../../../utils/auto-tenant-logger.js';
import { GameNotFoundError } from '../../../utils/domain-errors.js';

interface ReUploadGameParams {
  tenantId: string;
}

interface ReUploadGameBody {
  gameId: number;
  downloadMethod?: DownloadMethod;
}

interface DmcaClaim {
  type?: string;
  reason?: string;
  url?: string;
  [key: string]: unknown;
}

interface DmcaGameBody {
  gameId: number;
  claims: DmcaClaim[] | string;
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
      const game = await db.selectFrom('games').selectAll().where('id', '=', gameId).executeTakeFirst();

      if (!game) {
        throw new GameNotFoundError(gameId);
      }

      // Look up associated VOD
      const vodRecord = await db.selectFrom('vods').selectAll().where('id', '=', game.vod_id).executeTakeFirst();

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

      // Queue game upload using the game's own time range
      const gameJobId = await queueYoutubeGameUploadByGame(
        tenantPlatformCtx,
        dbId,
        vodId,
        filePath,
        platform,
        {
          id: game.id,
          name: game.game_name ?? '',
          start: game.start_time,
          end: game.end_time,
          gameId: game.game_id ?? undefined,
          title: game.title ?? undefined,
        },
        jobId ?? undefined
      );

      if (gameJobId == null) {
        return {
          data: {
            message: 'Game upload skipped (restricted game)',
            gameId,
            vodId,
          },
        };
      }

      if (jobId != null) {
        return {
          data: {
            message: 'VOD download queued, game upload will be triggered after completion',
            gameId,
            vodId,
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
          filePath,
          gameJobId,
        },
      };
    }
  );

  // DMCA processing for a single game
  fastify.post<{ Params: ReUploadGameParams; Body: DmcaGameBody }>(
    '/games/dmca',
    {
      schema: {
        tags: ['Admin'],
        description:
          'Queue DMCA processing for a single game (trims to chapter range, applies blackout/mute, re-uploads)',
        params: {
          type: 'object',
          properties: { tenantId: { type: 'string', description: 'Tenant ID' } },
          required: ['tenantId'],
        },
        body: {
          type: 'object',
          properties: {
            gameId: { type: 'number', description: 'Game database ID' },
            claims: { description: 'DMCA claims array or JSON string' },
            downloadMethod: {
              type: 'string',
              enum: DOWNLOAD_METHODS_VALUES,
              default: DOWNLOAD_METHODS.HLS,
              description: 'Download method for VOD',
            },
          },
          required: ['gameId', 'claims'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware, tenantMiddleware],
    },
    async (request) => {
      const tenantCtx = requireTenant(request);
      const { tenantId, config, db } = tenantCtx;
      const { gameId, claims, downloadMethod } = request.body;
      const log = createAutoLogger(tenantId);

      // Check if game exists
      const game = await db.selectFrom('games').selectAll().where('id', '=', gameId).executeTakeFirst();

      if (!game) {
        throw new GameNotFoundError(gameId);
      }

      // Look up associated VOD
      const vodRecord = await db.selectFrom('vods').selectAll().where('id', '=', game.vod_id).executeTakeFirst();

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

      // Parse claims (lenient - no validation)
      const claimsArray: unknown[] = Array.isArray(claims)
        ? claims
        : (JSON.parse(typeof claims === 'string' ? claims : JSON.stringify(claims)) as unknown[]);

      // Queue DMCA processing with game fields
      const dmcaJobId = await queueDmcaProcessing({
        tenantId,
        dbId,
        vodId: String(vodId),
        claims: claimsArray,
        type,
        platform,
        gameId,
        gameStart: game.start_time,
        gameEnd: game.end_time,
        downloadJobId: jobId ?? undefined,
        filePath,
      });

      if (dmcaJobId == null) {
        throw new Error('Failed to queue DMCA processing job');
      }

      if (jobId != null) {
        return {
          data: {
            message: 'VOD download queued, DMCA processing will be triggered after completion',
            gameId,
            vodId,
            downloadJobId: jobId,
            dmcaJobId,
          },
        };
      }

      return {
        data: {
          message: 'DMCA processing queued',
          gameId,
          vodId,
          filePath,
          dmcaJobId,
        },
      };
    }
  );

  return fastify;
}
