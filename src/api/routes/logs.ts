import { FastifyInstance } from 'fastify';
import { getLogsByOffset, getLogsByCursor } from '../../services/logs.service';
import { getClient } from '../../db/client';
import { getTenantConfig } from '../../config/loader';
import createRateLimitMiddleware from '../middleware/rate-limit';
import { chatRateLimiter } from '../plugins/redis.plugin';
import { badRequest, notFound, serviceUnavailable } from '../../utils/http-error';

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
    '/:tenantId/vods/:vodId/logs',
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
        badRequest('Missing required query parameter: content_offset_seconds or cursor');
      }

      const config = getTenantConfig(tenantId);
      if (!config) {
        notFound('Streamer not found');
      }

      const client = getClient(tenantId);
      if (!client) {
        serviceUnavailable('Database not available');
      }

      let result;

      if (cursor) {
        result = await getLogsByCursor(client, tenantId, vodId, cursor);
      } else if (content_offset_seconds !== undefined && !isNaN(content_offset_seconds)) {
        result = await getLogsByOffset(client, tenantId, vodId, content_offset_seconds);
      } else {
        badRequest('Invalid content_offset_seconds value');
      }

      return { data: result };
    }
  );
}
