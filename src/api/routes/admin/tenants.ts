import { FastifyInstance } from 'fastify';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import Redis from 'ioredis';
import fsPromises from 'fs/promises';
import { getTenantStats, getAllTenants } from '../../../services/tenants.service.js';
import { getClient } from '../../../db/client.js';
import { getStreamerConfig } from '../../../config/loader.js';
import createRateLimitMiddleware from '../../middleware/rate-limit.js';
import adminApiKeyMiddleware from '../../middleware/admin-api-key.js';
import { getYoutubeUploadQueue, getVODDownloadQueue } from '../../../jobs/queues.js';

type TenantsRoutesOptions = Record<string, unknown>;

declare module 'fastify' {
  interface FastifyInstance {
    adminRateLimiter: RateLimiterRedis;
  }
}

export default async function tenantsRoutes(fastify: FastifyInstance, _options: TenantsRoutesOptions) {
  const rateLimitMiddleware = createRateLimitMiddleware({
    limiter: fastify.adminRateLimiter,
  });

  fastify.get(
    '/',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'List all tenants (streamers)',
        security: [{ apiKey: [] }],
        headers: {
          type: 'object',
          properties: {
            Authorization: {
              type: 'string',
              description: 'Bearer token with API key (e.g., "Bearer archive_...")',
            },
            'X-API-Key': {
              type: 'string',
              description: 'Direct API key header as alternative to Bearer auth',
            },
          },
        },
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async () => {
      const tenants = await getAllTenants();
      return { data: tenants };
    }
  );

  fastify.get(
    '/:id/stats',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Get detailed stats for a tenant',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Tenant ID' },
          },
          required: ['id'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const { id } = request.params as { id: string };

      const config = getStreamerConfig(id);
      if (!config) {
        throw new Error('Tenant not found');
      }

      const client = getClient(id);
      if (!client) {
        throw new Error('Database not available');
      }

      const stats = await getTenantStats(client, id);
      return { data: stats };
    }
  );

  fastify.post(
    '/:id/vods/:vodId/re-upload-youtube',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Manually trigger YouTube re-upload for a VOD with duration validation',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            vodId: { type: 'string' },
          },
          required: ['id', 'vodId'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const { id, vodId } = request.params as { id: string; vodId: string };

      try {
        const config = getStreamerConfig(id);
        if (!config) throw new Error('Tenant not found');
        if (!config.youtube) throw new Error('YouTube integration not configured for this tenant');

        const client = getClient(id);
        if (!client) throw new Error('Database not available');

        const vodRecord: any = await (client as any).vod.findUnique({ where: { id: vodId } });
        if (!vodRecord) throw new Error(`VOD ${vodId} not found`);

        const finalMp4Path = `${config.settings.vodPath}/${id}/${vodId}.mp4`;

        await fsPromises.access(finalMp4Path).catch(() => {
          throw new Error('MP4 file not found. VOD may not have been processed yet.');
        });

        const { validateVideoDuration, compareDurations } = await import('../../../utils/video-validator.js');
        const actualDuration: number | null = await validateVideoDuration(finalMp4Path);

        if (!actualDuration) throw new Error('Could not determine video duration from MP4 file');

        let expectedSeconds: number | null = null;
        let comparisonResult: any = null;

        const durationStr = vodRecord.duration as string;

        if (vodRecord.platform === 'twitch' && typeof durationStr === 'string') {
          const [hrs, mins, secs] = durationStr.split(':').map(Number);
          expectedSeconds = hrs * 3600 + mins * 60 + secs;

          if (expectedSeconds > 0) {
            comparisonResult = await compareDurations(actualDuration, expectedSeconds);
            fastify.log.info(`[${vodId}] Duration validation: actual=${actualDuration}s vs expected=${expectedSeconds}s (${comparisonResult.diffPercent}% diff)`);

            if (!comparisonResult.valid && comparisonResult.diffPercent > 15) {
              request.log.warn(`Large duration mismatch detected for ${vodId}: ${comparisonResult.diffPercent}%`);
            } else {
              fastify.log.info(`[${vodId}] Duration validation: actual=${actualDuration}s (no expected duration to compare)`);
            }
          }

          const youtubeJob = {
            streamerId: id,
            vodId,
            filePath: finalMp4Path,
            title: `Re-upload: ${vodRecord.title || vodId}`,
            description: 'Manual re-upload triggered via admin endpoint',
            type: 'vod' as const,
          };

          await (getYoutubeUploadQueue() as any).add(youtubeJob, { id: `youtube-reupload:${vodId}:${Date.now()}` });

          return { data: { message: 'YouTube re-upload job queued', vodId, jobId: `youtube-reupload:${vodId}:${Date.now()}`, durationValidation: expectedSeconds ? comparisonResult : null } };
        } else {
          const youtubeJob = {
            streamerId: id,
            vodId,
            filePath: finalMp4Path,
            title: `Re-upload: ${vodRecord.title || vodId}`,
            description: 'Manual re-upload triggered via admin endpoint',
            type: 'vod' as const,
          };

          await (getYoutubeUploadQueue() as any).add(youtubeJob, { id: `youtube-reupload:${vodId}:${Date.now()}` });
          return { data: { message: 'YouTube re-upload job queued', vodId, jobId: `youtube-reupload:${vodId}:${Date.now()}`, durationValidation: null } };
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        request.log.error(`[${vodId}] Re-upload failed: ${errorMsg}`);
        throw new Error('Failed to queue re-upload job');
      }
    }
  );

  fastify.post(
    '/:id/vods/:vodId/re-download',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Manually trigger VOD download (clears Redis dedup key first)',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            vodId: { type: 'string' },
          },
          required: ['id', 'vodId'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request) => {
      const { id, vodId } = request.params as { id: string; vodId: string };

      try {
        const config = getStreamerConfig(id);
        if (!config) throw new Error('Tenant not found');

        const client = getClient(id);
        if (!client) throw new Error('Database not available');

        const vodRecord: any = await (client as any).vod.findUnique({ where: { id: vodId } });
        if (!vodRecord) throw new Error(`VOD ${vodId} not found`);

        const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

        try {
          await redis.del(`vod_download:${vodId}`);
          request.log.info(`[${vodId}] Cleared Redis dedup key for manual re-download`);
        } catch (err) {
          const errStr = err instanceof Error ? err.message : String(err);
          request.log.warn(`Failed to clear dedup key: ${errStr}`);
        }

        const downloadJob = {
          streamerId: id,
          vodId,
          platform: vodRecord.platform as 'twitch' | 'kick',
          userId: id,
        };

        await (getVODDownloadQueue() as any).add(downloadJob, { name: 'vod_download', id: `download:${vodId}:${Date.now()}` });

        return { data: { message: 'Re-download job queued', vodId, jobId: `download:${vodId}:${Date.now()}` } };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        request.log.error(`[${vodId}] Re-download failed: ${errorMsg}`);
        throw new Error('Failed to queue re-download job');
      }
    }
  );
}
