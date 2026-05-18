import { sql } from 'kysely';
import type { Expression, ExpressionBuilder, SqlBool } from 'kysely';
import type { ReadonlyKysely } from 'kysely/readonly';
import { z } from 'zod';
import { Cache, CacheSwr } from '../constants.js';
import { buildPagination } from '../db/queries/builders.js';
import type { DBClient, StreamerDB } from '../db/streamer-types.js';
import type { GameResponse } from '../types/games.js';
import { PLATFORM_VALUES } from '../types/platforms.js';
import type { SWRKey } from '../utils/cache-keys.js';
import { swrKeys } from '../utils/cache-keys.js';
import { withStaleWhileRevalidate } from '../utils/cache.js';
import { buildFtsQuery } from './vods.service.js';

/** Zod schema for validating games list query parameters. */
export const GameQuerySchema = z.object({
  game_name: z.string().optional(),
  title: z.string().optional(),
  platform: z.enum(PLATFORM_VALUES as [string, ...string[]]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  game_id: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['game_name', 'created_at']).default('created_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

/** Inferred type from GameQuerySchema — query parameters for listing games. */
export type GameQuery = z.infer<typeof GameQuerySchema>;

type GamesOrderByCol = 'game_name' | 'created_at';

function buildQueryCacheKey(tenantId: string, query: GameQuery, page: number, limit: number): SWRKey {
  return swrKeys.gameQuery(tenantId, query, page, limit);
}

/**
 * Build Kysely where clause and order-by config from a GameQuery.
 * Handles game_name FTS, title ILIKE, platform filter, date range, and game_id.
 */
function buildGameQuery(query: GameQuery): {
  where: (eb: ExpressionBuilder<StreamerDB, 'games'>) => Expression<SqlBool>;
  orderBy: { col: GamesOrderByCol; dir: 'asc' | 'desc' };
} {
  const where = (eb: ExpressionBuilder<StreamerDB, 'games'>) => {
    const conditions: Expression<SqlBool>[] = [];

    if (query.game_name != null) {
      const ftsQuery = buildFtsQuery(query.game_name);
      if (ftsQuery !== '') {
        conditions.push(
          sql`to_tsvector('english', coalesce("games"."game_name", '')) @@ to_tsquery('english', ${ftsQuery})`
        );
      }
    }

    if (query.title != null) {
      conditions.push(eb('title', 'ilike', `%${query.title}%`));
    }

    if (query.platform != null) {
      conditions.push(
        eb('vod_id', 'in', eb.selectFrom('vods').select('vods.id').where('platform', '=', query.platform))
      );
    }

    if (query.from != null) {
      conditions.push(sql`"games"."vod_id" in (select "id" from "vods" where "created_at" >= ${new Date(query.from)})`);
    }
    if (query.to != null) {
      conditions.push(sql`"games"."vod_id" in (select "id" from "vods" where "created_at" <= ${new Date(query.to)})`);
    }

    if (query.game_id != null) {
      conditions.push(eb('game_id', '=', query.game_id));
    }

    return eb.and(conditions);
  };

  const orderBy = {
    col: query.sort,
    dir: query.order,
  };

  return { where, orderBy };
}

/**
 * List games for a tenant with filtering, pagination, and Redis caching.
 */
export async function getGames(
  db: ReadonlyKysely<StreamerDB>,
  tenantId: string,
  query: GameQuery,
  options?: { signal?: AbortSignal }
): Promise<{ games: GameResponse[]; total: number }> {
  const { page, offset, limit } = buildPagination({ page: query.page, limit: query.limit, maxLimit: 100 });

  const cacheKey = buildQueryCacheKey(tenantId, query, page, limit);
  const { where, orderBy } = buildGameQuery(query);

  const fetcher = async () => {
    const [result, totalRow] = await Promise.all([
      db
        .selectFrom('games')
        .selectAll('games')
        .where(where)
        .orderBy(sql`${sql.ref(orderBy.col)}`, orderBy.dir)
        .limit(limit + 1)
        .offset(offset)
        .execute(options),
      db
        .selectFrom('games')
        .select((eb) => [eb.fn.count('id').as('cnt')])
        .where(where)
        .executeTakeFirst(options),
    ]);

    const total = Number(totalRow?.cnt ?? 0);
    const hasMore = result.length > limit;
    const resultGames = hasMore ? result.slice(0, limit) : result;
    return { games: resultGames as unknown as GameResponse[], total };
  };

  return withStaleWhileRevalidate(cacheKey, Cache.VOD_LIST_TTL, Cache.VOD_LIST_TTL * CacheSwr.STALE_RATIO, fetcher);
}

/** Zod schema for validating games library query parameters. */
export const GameLibraryQuerySchema = z.object({
  game_id: z.string().optional(),
  game_name: z.string().optional(),
  sort: z.enum(['count', 'game_name', 'recent']).default('count'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Inferred type from GameLibraryQuerySchema. */
export type GameLibraryQuery = z.infer<typeof GameLibraryQuerySchema>;

/** Shape of a game library entry. */
export interface GameLibraryEntry {
  game_id: string | null;
  game_name: string | null;
  chapter_image: string | null;
  count: number;
}

function buildGameLibraryCacheKey(tenantId: string, query: GameLibraryQuery, page: number, limit: number): SWRKey {
  return swrKeys.gameLibrary(tenantId, query, page, limit);
}

/**
 * List unique games grouped by game_id with VOD counts.
 * Supports filtering by game_id, game_name, and sorting by count, name, or last_played.
 */
export async function getGamesLibrary(
  db: ReadonlyKysely<StreamerDB>,
  tenantId: string,
  query: GameLibraryQuery,
  options?: { signal?: AbortSignal }
): Promise<{ games: GameLibraryEntry[]; total: number }> {
  const { page, offset, limit } = buildPagination({ page: query.page, limit: query.limit, maxLimit: 100 });

  const cacheKey = buildGameLibraryCacheKey(tenantId, query, page, limit);

  const fetcher = async () => {
    let baseQuery = db
      .selectFrom('games')
      .innerJoin('vods', 'games.vod_id', 'vods.id')
      .where('games.game_id', 'is not', null)
      .where('games.game_id', '!=', '');

    if (query.game_name != null) {
      baseQuery = baseQuery.where('games.game_name', 'ilike', `%${query.game_name}%`);
    }

    if (query.game_id != null) {
      baseQuery = baseQuery.where('games.game_id', '=', query.game_id);
    }

    const [result, totalRow] = await Promise.all([
      baseQuery
        .select([
          'games.game_id',
          (eb) => eb.fn.max('games.game_name').as('game_name'),
          (eb) => eb.fn.max('games.chapter_image').as('chapter_image'),
          (eb) => eb.fn.count('vods.id').distinct().as('count'),
          (eb) => eb.fn.max('vods.created_at').as('last_played'),
        ])
        .groupBy('games.game_id')
        .orderBy(
          query.sort === 'count'
            ? sql`${sql.ref('count')}`
            : query.sort === 'game_name'
              ? sql`${sql.ref('game_name')}`
              : sql`${sql.ref('last_played')}`,
          query.order
        )
        .limit(limit + 1)
        .offset(offset)
        .execute(options),
      baseQuery.select((eb) => [eb.fn.count('games.game_id').distinct().as('cnt')]).executeTakeFirst(options),
    ]);

    const total = Number(totalRow?.cnt ?? 0);
    const hasMore = result.length > limit;
    const resultGames = hasMore ? result.slice(0, limit) : result;
    return { games: resultGames as GameLibraryEntry[], total };
  };

  return withStaleWhileRevalidate(cacheKey, Cache.VOD_LIST_TTL, Cache.VOD_LIST_TTL * CacheSwr.STALE_RATIO, fetcher);
}

/**
 * Fetch a single game by its numeric DB ID with stale-while-revalidate caching.
 * Also embeds prev/next neighbors to prevent client-side thundering herds.
 */
export async function getGameById(
  db: DBClient,
  tenantId: string,
  gameId: number,
  options?: { signal?: AbortSignal }
): Promise<GameResponse | null> {
  const cacheKey = swrKeys.gameStatic(tenantId, gameId);

  const fetcher = async () => {
    const [game, prev, next] = await Promise.all([
      db.selectFrom('games').selectAll('games').where('id', '=', gameId).executeTakeFirst(options),
      db
        .selectFrom('games')
        .select(['id'])
        .where('id', '<', gameId)
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst(options),
      db
        .selectFrom('games')
        .select(['id'])
        .where('id', '>', gameId)
        .orderBy('id', 'asc')
        .limit(1)
        .executeTakeFirst(options),
    ]);

    if (!game) return null;
    const result = {
      ...(game as unknown as GameResponse),
      prev: prev ?? null,
      next: next ?? null,
    };
    return result;
  };

  const staticData = await withStaleWhileRevalidate(
    cacheKey,
    Cache.DETAILS_TTL,
    Cache.DETAILS_TTL * CacheSwr.STALE_RATIO,
    fetcher
  );

  if (!staticData) return null;
  return staticData;
}
