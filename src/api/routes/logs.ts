import { FastifyInstance } from 'fastify';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { getLogsByOffset, getLogsByCursor } from '../../services/logs.service';
import { getClient } from '../../db/client';
import { getTenantConfig } from '../../config/loader';
import createRateLimitMiddleware from '../middleware/rate-limit';

interface LogsRoutesOptions {
  prefix: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    chatRateLimiter: RateLimiterRedis;
  }
}

export default async function logsRoutes(fastify: FastifyInstance, _options: LogsRoutesOptions) {
  const rateLimitMiddleware = createRateLimitMiddleware({
    limiter: fastify.chatRateLimiter,
  });

  fastify.get(
    '/:/vods/:vodId/logs',
    {
      schema: {
        tags: ['Chat Logs'],
        description: 'Get chat logs for a VOD with pagination',
        params: {
          type: 'object',
          properties: {
            tenantId: { type: 'string', description: 'Tenant ID' },
            vodId: { type: 'string', description: 'VOD ID' },
          },
          required: ['tenantId', 'vodId'],
        },
        query: {
          type: 'object',
          properties: {
            content_offset_seconds: {
              type: 'number',
              description: 'Start from this timestamp (offset-based pagination)',
            },
            cursor: {
              type: 'string',
              description: 'Continue from cursor (cursor-based pagination, base64-encoded)',
            },
          },
        },
      },
      onRequest: rateLimitMiddleware,
    },
    async (request) => {
      const { tenantId, vodId } = request.params as { tenantId: string; vodId: string };
      const { content_offset_seconds, cursor } = request.query as { content_offset_seconds?: number; cursor?: string };

      if (!content_offset_seconds && !cursor) {
        throw new Error('Missing required query parameter: content_offset_seconds or cursor');
      }

      const config = getTenantConfig(tenantId);
      if (!config) {
        throw new Error('Streamer not found');
      }

      const client = getClient(tenantId);
      if (!client) {
        throw new Error('Database not available');
      }

      let result;

      if (cursor) {
        result = await getLogsByCursor(client, tenantId, vodId, cursor);
      } else if (content_offset_seconds !== undefined && !isNaN(content_offset_seconds)) {
        result = await getLogsByOffset(client, tenantId, vodId, content_offset_seconds);
      } else {
        throw new Error('Invalid content_offset_seconds value');
      }

      return { data: result };
    }
  );
}
