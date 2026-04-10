import { FastifyInstance } from 'fastify';
import createRateLimitMiddleware from '../../middleware/rate-limit';
import adminApiKeyMiddleware from '../../middleware/admin-api-key';
import { tenantPlatformMiddleware, type TenantPlatformContext } from '../../middleware/tenant-platform';
import { parseDurationToSeconds, queueEmoteFetch, ensureVodRecord } from './utils/vod-helpers';
import { adminRateLimiter } from '../../plugins/redis.plugin';
import { createAutoLogger } from '../../../utils/auto-tenant-logger.js';
import { notFound } from '../../../utils/http-error';

export default async function downloadJobsRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  if (!adminRateLimiter) {
    throw new Error('Rate limiter not initialized');
  }

  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: adminRateLimiter });

  // Main download endpoint - creates VOD record if missing, then queues download + emote + chat jobs + upload (Twitch/Kick)
  fastify.post<{
    Body: { vodId: string | number; type?: 'live' | 'vod'; platform: 'twitch' | 'kick'; path?: string; uploadMode?: 'vod' | 'all'; downloadMethod?: 'ffmpeg' | 'hls' };
    Params: { tenantId: string };
  }>(
    '/upload',
    {
      schema: {
        tags: ['Admin'],
        description: 'Create VOD record if missing, then queue download + emote + chat jobs (Twitch/Kick)',
        params: { type: 'object', properties: { tenantId: { type: 'string', minLength: 1, maxLength: 100, description: 'Tenant ID' } }, required: ['tenantId'] },
        body: {
          type: 'object',
          properties: {
            vodId: { type: 'string', minLength: 1, maxLength: 100 },
            type: { type: 'string', enum: ['live', 'vod'], default: 'vod' },
            platform: { type: 'string', enum: ['twitch', 'kick'] },
            uploadMode: { type: 'string', enum: ['vod', 'all'], default: 'all' },
            downloadMethod: { type: 'string', enum: ['ffmpeg', 'hls'], default: 'hls' },
          },
          required: ['vodId', 'platform'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware, tenantPlatformMiddleware],
    },
    async (request) => {
      const { tenantId, config, client, platform } = request.tenant as TenantPlatformContext;
      const log = createAutoLogger(tenantId);

      // Ensure VOD record exists or create it from platform API metadata
      const vodRecord = await ensureVodRecord(config, client, tenantId, request.body.vodId, platform, log);

      if (!vodRecord) {
        notFound(`VOD ${request.body.vodId} not found on ${platform}`);
      }

      // Queue emote save job (fire-and-forget within request context)
      const platformId = config?.[platform]?.id;

      if (platformId) {
        await queueEmoteFetch({
          tenantId,
          vodId: vodRecord.id,
          platform,
          platformId,
          log,
        });
      } else {
        log.warn(`No platform ID available for emote fetching on VOD ${request.body.vodId}`);
      }

      const { ensureVodDownload } = await import('./utils/vod-helpers.js');

      const type = request.body.type;

      // For live streams, use stream_id; for archived, use vod_id
      const fileIdentifier = type === 'live' ? vodRecord.stream_id || vodRecord.vod_id : vodRecord.vod_id;

      const filePath = await ensureVodDownload({
        tenantId,
        dbId: vodRecord.id,
        vodId: fileIdentifier,
        platform,
        type: type as 'live' | 'vod',
        downloadMethod: request.body.downloadMethod || 'hls',
        uploadMode: request.body.uploadMode || 'all',
      });

      // File is now guaranteed to exist and be valid (ensureVodDownload validated it)
      const { queueYoutubeUpload } = await import('../../../utils/upload-queue.js');

      await queueYoutubeUpload(tenantId, vodRecord.id, vodRecord.vod_id, filePath, request.body.uploadMode || 'all', platform, log);

      // Queue chat download job
      const VodQueueModule = await import('../../../jobs/queues');

      const durationSeconds = parseDurationToSeconds(vodRecord.duration, platform);

      void VodQueueModule.getChatDownloadQueue().add(
        'chat_download',
        { tenantId: tenantId, platformUserId: tenantId, dbId: vodRecord.id, vodId: vodRecord.vod_id, platform, duration: durationSeconds },
        { jobId: `chat_${vodRecord.vod_id}` }
      );

      const chatJobId = `chat_${vodRecord.vod_id}`;

      log.info(`VOD download complete, upload queued for ${vodRecord.vod_id}, chat job: ${chatJobId}`);

      return {
        data: {
          message: 'VOD download complete, upload queued',
          dbId: vodRecord.id,
          vodId: vodRecord.vod_id,
          path: filePath,
          chatJobId,
        },
      };
    }
  );
  return fastify;
}
