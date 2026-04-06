import { FastifyInstance } from 'fastify';
import { getVods, getVodById, getVodByPlatformId } from '../../services/vods.service';
import { getClient } from '../../db/client';
import { getTenantConfig } from '../../config/loader';
import createRateLimitMiddleware from '../middleware/rate-limit';
import { publicRateLimiter } from '../plugins/redis.plugin';
import { notFound, serviceUnavailable } from '../../utils/http-error';

interface VodRoutesOptions {
  prefix: string;
}

export default async function vodsRoutes(fastify: FastifyInstance, _options: VodRoutesOptions) {
  if (!publicRateLimiter) {
    throw new Error('Rate limiter not initialized');
  }

  const rateLimitMiddleware = createRateLimitMiddleware({
    limiter: publicRateLimiter,
  });

  fastify.get(
    '/:tenantId/vods',
    {
      schema: {
        tags: ['VODs'],
        description: 'List all VODs for a streamer with filtering and pagination',
        params: {
          type: 'object',
          properties: {
            tenantId: { type: 'string', description: 'Tenant ID' },
          },
          required: ['tenantId'],
        },
        query: {
          type: 'object',
          properties: {
            platform: { type: 'string', enum: ['twitch', 'kick'], description: 'Filter by source platform' },
            from: { type: 'string', format: 'date-time', description: 'Filter VODs after date (ISO)' },
            to: { type: 'string', format: 'date-time', description: 'Filter VODs before date (ISO)' },
            uploaded: { type: 'string', enum: ['youtube'], description: 'Only VODs with YouTube uploads' },
            game: { type: 'string', description: 'Fuzzy search in chapters.name' },
            page: { type: 'integer', minimum: 1, default: 1, description: 'Page number' },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Items per page' },
            sort: { type: 'string', enum: ['created_at', 'duration', 'uploaded_at'], default: 'created_at' },
            order: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
          },
        },
      },
      onRequest: rateLimitMiddleware,
    },
    async (request) => {
      const { tenantId } = request.params as { tenantId: string };
      const query = request.query as Record<string, unknown>;

      const config = getTenantConfig(tenantId);
      if (!config) {
        notFound('Streamer not found');
      }

      const client = getClient(tenantId);
      if (!client) {
        serviceUnavailable('Database not available');
      }

      const { vods, total } = await getVods(client, tenantId, query as never);
      const page = Math.max(1, (query.page as number) || 1);
      const limit = Math.min(100, Math.max(1, (query.limit as number) || 20));

      return {
        data: vods,
        meta: {
          page,
          limit,
          total,
        },
      };
    }
  );

  fastify.get(
    '/:tenantId/vods/:vodId',
    {
      schema: {
        tags: ['VODs'],
        description: 'Get a single VOD by ID',
        params: {
          type: 'object',
          properties: {
            tenantId: { type: 'string', description: 'Tenant ID' },
            vodId: { type: 'number', description: 'VOD ID' },
          },
          required: ['tenantId', 'vodId'],
        },
      },
      onRequest: rateLimitMiddleware,
    },
    async (request) => {
      const { tenantId, vodId } = request.params as { tenantId: string; vodId: string };

      const config = getTenantConfig(tenantId);
      if (!config) {
        notFound('Streamer not found');
      }

      const client = getClient(tenantId);
      if (!client) {
        serviceUnavailable('Database not available');
      }

      const vodIdNum = Number(vodId);

      if (isNaN(vodIdNum) || vodIdNum < 0 || vodIdNum > 2147483647) {
        notFound('VOD not found');
      }

      const vod = await getVodById(client, tenantId, vodIdNum);

      if (!vod) {
        notFound('VOD not found');
      }

      return { data: vod };
    }
  );

  fastify.get(
    '/:tenantId/vods/:platform/:platformVodId',
    {
      schema: {
        tags: ['VODs'],
        description: 'Get a single VOD by platform-specific ID',
        params: {
          type: 'object',
          properties: {
            tenantId: { type: 'string', description: 'Tenant ID' },
            platform: { type: 'string', enum: ['twitch', 'kick'], description: 'Platform' },
            platformVodId: { type: 'string', description: 'Platform-specific VOD ID' },
          },
          required: ['tenantId', 'platform', 'platformVodId'],
        },
      },
      onRequest: rateLimitMiddleware,
    },
    async (request) => {
      const { tenantId, platform, platformVodId } = request.params as { tenantId: string; platform: 'twitch' | 'kick'; platformVodId: string };

      const config = getTenantConfig(tenantId);
      if (!config) {
        notFound('Streamer not found');
      }

      const client = getClient(tenantId);
      if (!client) {
        serviceUnavailable('Database not available');
      }

      const vod = await getVodByPlatformId(client, tenantId, platform, platformVodId);

      if (!vod) {
        notFound('VOD not found');
      }

      return { data: vod };
    }
  );
}
