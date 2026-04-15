import { FastifyInstance } from 'fastify';
import { getLogsByOffset, getLogsByCursor } from '../../services/logs.service';
import createRateLimitMiddleware from '../middleware/rate-limit';
import { chatRateLimiter } from '../plugins/redis.plugin';
import { badRequest } from '../../utils/http-error';
import { tenantMiddleware } from '../middleware/tenant-platform';

interface LogsRoutesOptions {
  prefix: string;
}

export default async function logsRoutes(fastify: FastifyInstance, _options: LogsRoutesOptions) {
  if (!chatRateLimiter) {
    throw new Error('Rate limiter not initialized');
  }

  const rateLimitMiddleware = createRateLimitMiddleware({
    limiter: chatRateLimiter,
  });

  fastify.get(
    '/:tenantId/vods/:vodId/comments',
    {
      schema: {
        tags: ['VODs'],
        description: 'Get chat comments for a VOD with pagination',
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
      onRequest: [rateLimitMiddleware, tenantMiddleware],
    },
    async (request) => {
      const { tenantId, vodId } = request.params as { tenantId: string; vodId: string };
      const { db } = request.tenant;
      const vodIdNum = Number(vodId);
      const { content_offset_seconds, cursor } = request.query as { content_offset_seconds?: number; cursor?: string };

      if (content_offset_seconds === undefined && !cursor) {
        badRequest('Missing required query parameter: content_offset_seconds or cursor');
      }

      let result;

      if (cursor) {
        result = await getLogsByCursor(db, tenantId, vodIdNum, cursor);
      } else if (content_offset_seconds !== undefined && !isNaN(content_offset_seconds)) {
        result = await getLogsByOffset(db, tenantId, vodIdNum, content_offset_seconds);
      } else {
        badRequest('Invalid content_offset_seconds value');
      }

      return { data: result };
    }
  );
}
