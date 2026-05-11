import { FastifyInstance } from 'fastify';
import type { ReadonlyKysely } from 'kysely/readonly';
import type { StreamerDB } from '../../db/streamer-types.js';
import { getGames, getGamesLibrary, GameQuerySchema, GameLibraryQuerySchema } from '../../services/games.service.js';
import { PLATFORM_VALUES } from '../../types/platforms.js';
import createRateLimitMiddleware from '../middleware/rate-limit.js';
import { tenantMiddleware, requireTenant } from '../middleware/tenant-platform.js';
import { okPaginated } from '../response.js';

/** Options for registering the games routes plugin. */
interface GamesRoutesOptions {
  prefix: string;
}

/**
 * Register games routes: list individual games with filtering and pagination,
 * and list games library with grouping and pagination.
 * All routes require tenant middleware and rate limiting.
 */
export default function gamesRoutes(fastify: FastifyInstance, _options: GamesRoutesOptions) {
  const rateLimitMiddleware = createRateLimitMiddleware({
    limiter: fastify.publicRateLimiter,
  });

  fastify.get(
    '/:tenantId/games',
    {
      schema: {
        tags: ['Games'],
        description: 'List all games/chapters with filtering and pagination',
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
            game_name: { type: 'string', description: 'Full-text search in game name' },
            title: { type: 'string', description: 'Fuzzy search in game title' },
            platform: { type: 'string', enum: PLATFORM_VALUES, description: 'Filter by source platform' },
            from: { type: 'string', format: 'date-time', description: 'Filter games after date (ISO)' },
            to: { type: 'string', format: 'date-time', description: 'Filter games before date (ISO)' },
            game_id: { type: 'string', description: 'Exact match by game_id' },
            page: { type: 'integer', minimum: 1, default: 1, description: 'Page number' },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Items per page' },
            sort: { type: 'string', enum: ['game_name', 'created_at'], default: 'game_name' },
            order: { type: 'string', enum: ['asc', 'desc'], default: 'asc' },
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

        const query = GameQuerySchema.parse(request.query);
        const { games, total } = await getGames(db as unknown as ReadonlyKysely<StreamerDB>, tenantId, query, {
          signal: controller.signal,
        });

        return okPaginated(games, {
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

  fastify.get(
    '/:tenantId/games/library',
    {
      schema: {
        tags: ['Games'],
        description: 'List unique games grouped by game_id with VOD counts',
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
            game_id: { type: 'string', description: 'Exact match by game_id' },
            game_name: { type: 'string', description: 'Fuzzy search in game name' },
            sort: { type: 'string', enum: ['count', 'game_name', 'recent'], default: 'count' },
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

        const query = GameLibraryQuerySchema.parse(request.query);
        const { games, total } = await getGamesLibrary(db as unknown as ReadonlyKysely<StreamerDB>, tenantId, query, {
          signal: controller.signal,
        });

        return okPaginated(games, {
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
