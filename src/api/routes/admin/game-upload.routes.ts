import { FastifyInstance } from 'fastify';
import type { SourceType, DownloadMethod } from '../../../types/platforms.js';
import { DOWNLOAD_METHODS, DOWNLOAD_METHODS_VALUES, SOURCE_TYPES } from '../../../types/platforms.js';
import { createAutoLogger } from '../../../utils/auto-tenant-logger.js';
import { internalServerError } from '../../../utils/http-error.js';
import { queueDmcaProcessing } from '../../../workers/jobs/dmca.job.js';
import { queueYoutubeGameUploadByGame } from '../../../workers/jobs/youtube.job.js';
import adminApiKeyMiddleware from '../../middleware/admin-api-key.js';
import createRateLimitMiddleware from '../../middleware/rate-limit.js';
import { tenantMiddleware, requireTenant } from '../../middleware/tenant-platform.js';
import { ok } from '../../response.js';
import { parseDmcaClaims } from './utils/dmca.js';
import { resolveGameWithContext } from './utils/game-context.js';
import { ensureVodDownload } from './utils/vod-downloads.js';
import { buildVodJobResponse } from './utils/vod-job-response.js';

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
  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: fastify.adminRateLimiter });

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

      const resolved = await resolveGameWithContext(gameId, db, tenantCtx, config);
      const { game, dbId, vodId, platform, tenantPlatformCtx } = resolved;
      const type: SourceType = SOURCE_TYPES.VOD;

      // Ensure VOD file is downloaded and valid
      const { jobId, filePath, copyJobId, workDir } = await ensureVodDownload({
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
        game,
        jobId ?? undefined,
        workDir,
        copyJobId
      );

      if (gameJobId == null) {
        return ok({
          message: 'Game upload skipped (restricted game)',
          gameId,
          vodId,
        });
      }

      return buildVodJobResponse({
        hasDownload: jobId != null,
        filePath,
        downstreamJobId: gameJobId,
        downstreamLabel: 'Game upload',
        copyJobId,
        base: { gameId, vodId },
      });
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

      const resolved = await resolveGameWithContext(gameId, db, tenantCtx, config);
      const { game, dbId, vodId, platform, tenantPlatformCtx } = resolved;
      const type: SourceType = SOURCE_TYPES.VOD;

      // Ensure VOD file is downloaded and valid
      const { jobId, filePath, copyJobId } = await ensureVodDownload({
        ctx: tenantPlatformCtx,
        dbId,
        vodId,
        type,
        downloadMethod,
        log,
      });

      // Parse claims (lenient - no validation)
      const claimsArray = parseDmcaClaims(claims);

      // Queue DMCA processing with game fields
      const dmcaJobId = await queueDmcaProcessing({
        tenantId,
        dbId,
        vodId,
        claims: claimsArray,
        type,
        platform,
        gameId,
        gameStart: game.start,
        gameDuration: game.end - game.start,
        downloadJobId: jobId ?? undefined,
        copyJobId,
        filePath,
      });

      if (dmcaJobId == null) {
        return internalServerError('Failed to queue DMCA processing job');
      }

      return buildVodJobResponse({
        hasDownload: jobId != null,
        filePath,
        downstreamJobId: dmcaJobId,
        downstreamLabel: 'DMCA processing',
        copyJobId,
        base: { gameId, vodId },
      });
    }
  );

  return fastify;
}
