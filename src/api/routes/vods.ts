import { FastifyInstance } from 'fastify';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { getVods, getVodById } from '../../services/vods.service';
import { getClient } from '../../db/client';
import { getStreamerConfig } from '../../config/loader';
import createRateLimitMiddleware from '../middleware/rate-limit';

interface VodRoutesOptions {
  prefix: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    publicRateLimiter: RateLimiterRedis;
  }
}

export default async function vodsRoutes(fastify: FastifyInstance, _options: VodRoutesOptions) {
  const rateLimitMiddleware = createRateLimitMiddleware({
    limiter: fastify.publicRateLimiter,
  });

  fastify.get(
    '/:streamerId/vods',
    {
      schema: {
        tags: ['VODs'],
        description: 'List all VODs for a streamer with filtering and pagination',
        params: {
          type: 'object',
          properties: {
            streamerId: { type: 'string', description: 'Streamer ID' },
          },
          required: ['streamerId'],
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
      const { streamerId } = request.params as { streamerId: string };
      const query = request.query as Record<string, unknown>;

      const config = getStreamerConfig(streamerId);
      if (!config) {
        throw new Error('Streamer not found');
      }

      const client = getClient(streamerId);
      if (!client) {
        throw new Error('Database not available');
      }

      const { vods, total } = await getVods(client, streamerId, query as never);
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
    '/:streamerId/vods/:vodId',
    {
      schema: {
        tags: ['VODs'],
        description: 'Get a single VOD by ID',
        params: {
          type: 'object',
          properties: {
            streamerId: { type: 'string', description: 'Streamer ID' },
            vodId: { type: 'string', description: 'VOD ID' },
          },
          required: ['streamerId', 'vodId'],
        },
      },
      onRequest: rateLimitMiddleware,
    },
    async (request) => {
      const { streamerId, vodId } = request.params as { streamerId: string; vodId: string };

      const config = getStreamerConfig(streamerId);
      if (!config) {
        throw new Error('Streamer not found');
      }

      const client = getClient(streamerId);
      if (!client) {
        throw new Error('Database not available');
      }

      const vod = await getVodById(client, streamerId, vodId);

      if (!vod) {
        throw new Error('VOD not found');
      }

      return { data: vod };
    }
  );
}
