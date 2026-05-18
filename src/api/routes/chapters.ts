import { FastifyInstance } from 'fastify';
import type { ReadonlyKysely } from 'kysely/readonly';
import type { StreamerDB } from '../../db/streamer-types.js';
import { getChaptersLibrary, ChapterLibraryQuerySchema } from '../../services/chapters.service.js';
import createRateLimitMiddleware from '../middleware/rate-limit.js';
import { tenantMiddleware, requireTenant } from '../middleware/tenant-platform.js';
import { okPaginated } from '../response.js';

/** Options for registering the chapters routes plugin. */
interface ChaptersRoutesOptions {
  prefix: string;
}

/**
 * Register chapters routes: list chapters library with grouping and pagination.
 * All routes require tenant middleware and rate limiting.
 */
export default function chaptersRoutes(fastify: FastifyInstance, _options: ChaptersRoutesOptions) {
  const rateLimitMiddleware = createRateLimitMiddleware({
    limiter: fastify.publicRateLimiter,
  });

  fastify.get(
    '/:tenantId/chapters/library',
    {
      schema: {
        tags: ['Chapters'],
        description: 'List unique chapters grouped by game_id with VOD counts',
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
            chapter_name: { type: 'string', description: 'Fuzzy search in chapter name' },
            sort: { type: 'string', enum: ['count', 'chapter_name', 'recent'], default: 'count' },
            order: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
            page: { type: 'integer', minimum: 1, default: 1, description: 'Page number' },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 50, description: 'Items per page' },
          },
        },
      },
      onRequest: [rateLimitMiddleware, tenantMiddleware],
    },
    async (request) => {
      const controller = new AbortController();
      request.raw.once('close', () => {
        if (request.raw.destroyed) {
          controller.abort();
        }
      });

      try {
        const tenantCtx = requireTenant(request);
        const { tenantId, db } = tenantCtx;

        const query = ChapterLibraryQuerySchema.parse(request.query);
        const { chapters, total } = await getChaptersLibrary(
          db as unknown as ReadonlyKysely<StreamerDB>,
          tenantId,
          query,
          { signal: controller.signal }
        );

        return okPaginated(chapters, {
          page: query.page,
          limit: query.limit,
          total,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        throw err;
      }
    }
  );

  return fastify;
}
