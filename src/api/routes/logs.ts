import { FastifyInstance, FastifySchema } from 'fastify';
import { z } from 'zod';
import { getLogsByOffset, getLogsByCursor } from '../../services/logs.service.js';
import createRateLimitMiddleware from '../middleware/rate-limit.js';
import { RedisService } from '../../utils/redis-service.js';
import { HttpError } from '../../utils/http-error.js';
import { tenantMiddleware, requireTenant } from '../middleware/tenant-platform.js';

const LogsQuerySchema = z.object({
  content_offset_seconds: z.number().nonnegative().optional(),
  cursor: z.string().optional(),
});

/** Options for registering the logs routes plugin. */
interface LogsRoutesOptions {
  prefix: string;
}

/**
 * Register chat logs routes: fetch comments for a VOD with offset or cursor pagination.
 * Requires tenant middleware and rate limiting.
 */
export default function logsRoutes(fastify: FastifyInstance, _options: LogsRoutesOptions) {
  const chatRateLimiter = RedisService.requireLimiter('rate:chat');

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
      const tenantCtx = requireTenant(request);
      const { db } = tenantCtx;
      const vodIdNum = Number(vodId);

      const parsed = LogsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw new HttpError(400, 'Invalid query parameters', 'BAD_REQUEST');
      }

      const { content_offset_seconds, cursor } = parsed.data;

      if (content_offset_seconds === undefined && cursor == null) {
        throw new HttpError(400, 'Missing required query parameter: content_offset_seconds or cursor', 'BAD_REQUEST');
      }

      let result;

      if (cursor != null) {
        result = await getLogsByCursor(db, tenantId, vodIdNum, cursor);
      } else if (content_offset_seconds !== undefined && !isNaN(content_offset_seconds)) {
        result = await getLogsByOffset(db, tenantId, vodIdNum, content_offset_seconds);
      } else {
        throw new HttpError(400, 'Invalid content_offset_seconds value', 'BAD_REQUEST');
      }

      return { data: result };
    }
  );
}
