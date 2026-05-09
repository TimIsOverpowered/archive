import { FastifyInstance, FastifySchema } from 'fastify';
import type { ReadonlyKysely } from 'kysely/readonly';
import { z } from 'zod';
import type { StreamerDB } from '../../db/streamer-types.js';
import { getLogsByOffset, getLogsByCursor } from '../../services/logs.service.js';
import { badRequest } from '../../utils/http-error.js';
import createRateLimitMiddleware from '../middleware/rate-limit.js';
import { tenantMiddleware, requireTenant } from '../middleware/tenant-platform.js';
import { ok } from '../response.js';

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
  const rateLimitMiddleware = createRateLimitMiddleware({
    limiter: fastify.chatRateLimiter,
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
      const controller = new AbortController();
      request.raw.once('close', () => {
        controller.abort();
      });

      const { tenantId, vodId } = request.params;
      const tenantCtx = requireTenant(request);
      const { db } = tenantCtx;
      const vodIdNum = Number(vodId);
      if (isNaN(vodIdNum)) return badRequest('Invalid VOD ID');

      const parsed = LogsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        badRequest('Invalid query parameters');
      }

      const { content_offset_seconds, cursor } = parsed.data;

      if (content_offset_seconds === undefined && cursor == null) {
        badRequest('Missing required query parameter: content_offset_seconds or cursor');
      }

      let result;

      if (cursor != null) {
        result = await getLogsByCursor(db as unknown as ReadonlyKysely<StreamerDB>, tenantId, vodIdNum, cursor, {
          signal: controller.signal,
        });
      } else if (content_offset_seconds !== undefined && !isNaN(content_offset_seconds)) {
        result = await getLogsByOffset(
          db as unknown as ReadonlyKysely<StreamerDB>,
          tenantId,
          vodIdNum,
          content_offset_seconds,
          { signal: controller.signal }
        );
      } else {
        badRequest('Invalid content_offset_seconds value');
      }

      return ok(result);
    }
  );
}
