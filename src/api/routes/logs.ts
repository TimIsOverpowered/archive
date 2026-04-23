import { FastifyInstance, FastifySchema } from 'fastify';
import { getLogsByOffset, getLogsByCursor } from '../../services/logs.service.js';
import createRateLimitMiddleware from '../middleware/rate-limit.js';
import { RedisService } from '../../utils/redis-service.js';
import { badRequest } from '../../utils/http-error.js';
import { tenantMiddleware } from '../middleware/tenant-platform.js';

interface LogsRoutesOptions {
  prefix: string;
}

export default async function logsRoutes(fastify: FastifyInstance, _options: LogsRoutesOptions) {
  const chatRateLimiter = RedisService.getLimiter('rate:chat');
  if (!chatRateLimiter) {
    throw new Error('Rate limiter not initialized');
  }

  const rateLimitMiddleware = createRateLimitMiddleware({
    limiter: chatRateLimiter,
  });

  fastify.get<{
    Params: { tenantId: string; vodId: string };
    Querystring: { content_offset_seconds?: number; cursor?: string };
  }>(
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
      } as FastifySchema,
      onRequest: [rateLimitMiddleware, tenantMiddleware],
    },
    async (request) => {
      const { tenantId, vodId } = request.params;
      const { db } = request.tenant;
      const vodIdNum = Number(vodId);
      const { content_offset_seconds, cursor } = request.query;

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
