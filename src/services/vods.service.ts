import { sql } from 'kysely';
import type { Expression, ExpressionBuilder, SqlBool } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import type { ReadonlyKysely } from 'kysely/readonly';
import { z } from 'zod';
import { Cache, CacheSwr, Fts } from '../constants.js';
import { buildPagination } from '../db/queries/builders.js';
import type { StreamerDB, DBClient } from '../db/streamer-types.js';
import { Platform, PLATFORM_VALUES } from '../types/platforms.js';
import type { VodNeighbor, VodResponse } from '../types/vods.js';
import type { SWRKey } from '../utils/cache-keys.js';
import { swrKeys } from '../utils/cache-keys.js';
import { withStaleWhileRevalidate } from '../utils/cache.js';
import { registerVodTags } from './cache-tags.js';
import { getVodVolatileCache, getVodVolatileCacheBatch } from './vod-cache.js';

const FtsSpecialChars = /[&|()@:"\\:]/g;

function formatFtsTerm(term: string): string {
  const escaped = term.replace(FtsSpecialChars, '');
  if (escaped === '') return '';
  return `${escaped}:*`;
}

export function buildFtsQuery(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean).slice(0, Fts.MAX_WORDS);
  if (words.length === 0) return '';
  return words.map(formatFtsTerm).filter(Boolean).join(' & ');
}

function applyVolatileData(
  vods: VodResponse[],
  volatileMap: Map<number, { duration: number | null; is_live: boolean }>
): VodResponse[] {
  return vods.map((vod) => {
    const volatile = volatileMap.get(vod.id);
    return volatile ? ({ ...vod, duration: volatile.duration, is_live: volatile.is_live } as VodResponse) : vod;
  });
}

function buildQueryCacheKey(tenantId: string, query: VodQuery, page: number, limit: number): SWRKey {
  return swrKeys.vodQuery(tenantId, query, page, limit);
}

function selectVodRelations(eb: ExpressionBuilder<StreamerDB, 'vods'>) {
  return [
    jsonArrayFrom(
      eb
        .selectFrom('vod_uploads')
        .select(['id', 'upload_id', 'type', 'duration', 'part', 'status', 'thumbnail_url', 'created_at'])
        .whereRef('vod_uploads.vod_id', '=', 'vods.id')
    ).as('vod_uploads'),
    jsonArrayFrom(
      eb
        .selectFrom('chapters')
        .select(['name', 'image', 'start', 'duration', 'end'])
        .whereRef('chapters.vod_id', '=', 'vods.id')
    ).as('chapters'),
    jsonArrayFrom(
      eb
        .selectFrom('games')
        .select([
          'id',
          'start',
          'duration',
          'end',
          'video_provider',
          'video_id',
          'thumbnail_url',
          'game_id',
          'game_name',
          'title',
          'chapter_image',
        ])
        .whereRef('games.vod_id', '=', 'vods.id')
    ).as('games'),
  ] as const;
}

/** Zod schema for validating VOD list query parameters. */
export const VodQuerySchema = z.object({
  platform: z.enum(PLATFORM_VALUES as [string, ...string[]]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  uploaded: z.literal('youtube').optional(),
  game: z.string().optional(),
  game_id: z.string().optional(),
  title: z.string().optional(),
  chapter: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['created_at', 'duration']).default('created_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

/** Inferred type from VodQuerySchema — query parameters for listing VODs. */
export type VodQuery = z.infer<typeof VodQuerySchema>;

type VodsOrderByCol = 'created_at' | 'duration';

/**
 * Build Kysely where clause and order-by config from a VodQuery.
 * Handles platform, date range, YouTube upload filter, game name search,
 * and full-text search on title and chapter name.
 */
export function buildVodQuery(query: VodQuery): {
  where: (eb: ExpressionBuilder<StreamerDB, 'vods'>) => Expression<SqlBool>;
  orderBy: { col: VodsOrderByCol; dir: 'asc' | 'desc' };
} {
  const where = (eb: ExpressionBuilder<StreamerDB, 'vods'>) => {
    const conditions: Expression<SqlBool>[] = [];

    if (query.platform != null) {
      conditions.push(eb('platform', '=', query.platform));
    }

    if (query.from != null) {
      conditions.push(eb('created_at', '>=', new Date(query.from)));
    }
    if (query.to != null) {
      conditions.push(eb('created_at', '<=', new Date(query.to)));
    }

    if (query.uploaded === 'youtube') {
      conditions.push(eb('id', 'in', eb.selectFrom('vod_uploads').select('vod_uploads.vod_id')));
    }

    if (query.game != null) {
      conditions.push(
        eb('id', 'in', eb.selectFrom('games').select('games.vod_id').where('game_name', 'ilike', `%${query.game}%`))
      );
    }

    if (query.game_id != null) {
      conditions.push(
        eb('id', 'in', eb.selectFrom('chapters').select('chapters.vod_id').where('game_id', '=', query.game_id))
      );
    }

    if (query.title != null) {
      const ftsQuery = buildFtsQuery(query.title);
      if (ftsQuery !== '') {
        conditions.push(
          sql`to_tsvector('english', coalesce("vods"."title", '')) @@ to_tsquery('english', ${ftsQuery})`
        );
      }
    }

    if (query.chapter != null) {
      const ftsQuery = buildFtsQuery(query.chapter);
      if (ftsQuery !== '') {
        conditions.push(
          eb(
            'id',
            'in',
            eb
              .selectFrom('chapters')
              .select('chapters.vod_id')
              .where(
                sql`to_tsvector('english', coalesce("chapters"."name", '')) @@ to_tsquery('english', ${ftsQuery})` as Expression<SqlBool>
              )
          )
        );
      }
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
 * List VODs for a tenant with filtering, pagination, and Redis caching.
 * Applies volatile cache data (duration, is_live) on top of cached static data.
 */
export async function getVods(
  db: ReadonlyKysely<StreamerDB>,
  tenantId: string,
  query: VodQuery,
  options?: { signal?: AbortSignal }
): Promise<{ vods: VodResponse[]; total: number }> {
  const { page, offset, limit } = buildPagination({ page: query.page, limit: query.limit, maxLimit: 100 });

  const cacheKey = buildQueryCacheKey(tenantId, query, page, limit);
  const { where, orderBy } = buildVodQuery(query);

  const fetcher = async () => {
    const [result, totalRow] = await Promise.all([
      db
        .selectFrom('vods')
        .selectAll('vods')
        .select((eb) => selectVodRelations(eb))
        .where(where)
        .orderBy(sql`${sql.ref(orderBy.col)}`, orderBy.dir)
        .limit(limit + 1)
        .offset(offset)
        .execute(options),
      db
        .selectFrom('vods')
        .select((eb) => [eb.fn.count('id').as('cnt')])
        .where(where)
        .executeTakeFirst(options),
    ]);

    const total = Number(totalRow?.cnt ?? 0);
    const hasMore = result.length > limit;
    const resultVods = (hasMore ? result.slice(0, limit) : result) as unknown as VodResponse[];

    await registerVodTags(tenantId, resultVods, cacheKey, Cache.VOD_LIST_TTL, page);

    return { vods: resultVods, total };
  };

  const staticData = await withStaleWhileRevalidate(
    cacheKey,
    Cache.VOD_LIST_TTL,
    Cache.VOD_LIST_TTL * CacheSwr.STALE_RATIO,
    fetcher
  );

  const dbIds = staticData.vods.map((v) => v.id);
  const volatileMap = await getVodVolatileCacheBatch(tenantId, dbIds);
  const mergedVods = applyVolatileData(staticData.vods, volatileMap);

  return { vods: mergedVods, total: staticData.total };
}

/**
 * Fetch a single VOD by its numeric DB ID with stale-while-revalidate caching.
 * Merges volatile data (duration, is_live) from Redis on top of cached static data.
 * Also embeds prev/next neighbors securely to prevent DB thundering herds.
 */
export async function getVodById(
  db: DBClient,
  tenantId: string,
  vodId: number,
  options?: { signal?: AbortSignal }
): Promise<VodResponse | null> {
  const cacheKey = swrKeys.vodStatic(tenantId, vodId);

  const fetcher = async () => {
    const vod = await db
      .selectFrom('vods')
      .selectAll('vods')
      .select((eb) => selectVodRelations(eb))
      .where('id', '=', vodId)
      .executeTakeFirst(options);

    if (!vod) return null;

    const [prevRaw, nextRaw] = await Promise.all([
      db
        .selectFrom('vods')
        .select(['id', 'platform', 'platform_vod_id', 'title', 'duration', 'created_at'])
        .select((eb) =>
          eb
            .selectFrom('vod_uploads')
            .select('thumbnail_url')
            .whereRef('vod_uploads.vod_id', '=', 'vods.id')
            .orderBy('vod_uploads.created_at', 'asc')
            .limit(1)
            .as('thumbnail_url')
        )
        .select((eb) =>
          jsonArrayFrom(
            eb
              .selectFrom('chapters')
              .select(['name', 'image', 'start', 'duration', 'end'])
              .whereRef('chapters.vod_id', '=', 'vods.id')
          ).as('chapters')
        )
        .select((eb) =>
          jsonArrayFrom(
            eb
              .selectFrom('games')
              .select([
                'start',
                'duration',
                'end',
                'video_provider',
                'video_id',
                'thumbnail_url',
                'game_id',
                'game_name',
                'title',
                'chapter_image',
              ])
              .whereRef('games.vod_id', '=', 'vods.id')
          ).as('games')
        )
        .where((eb) =>
          eb.or([
            eb('created_at', '>', vod.created_at),
            eb.and([eb('created_at', '=', vod.created_at), eb('id', '>', vodId)]),
          ])
        )
        .orderBy('created_at', 'asc')
        .orderBy('id', 'asc')
        .limit(4)
        .execute(options),
      db
        .selectFrom('vods')
        .select(['id', 'platform', 'platform_vod_id', 'title', 'duration', 'created_at'])
        .select((eb) =>
          eb
            .selectFrom('vod_uploads')
            .select('thumbnail_url')
            .whereRef('vod_uploads.vod_id', '=', 'vods.id')
            .orderBy('vod_uploads.created_at', 'asc')
            .limit(1)
            .as('thumbnail_url')
        )
        .select((eb) =>
          jsonArrayFrom(
            eb
              .selectFrom('chapters')
              .select(['name', 'image', 'start', 'duration', 'end'])
              .whereRef('chapters.vod_id', '=', 'vods.id')
          ).as('chapters')
        )
        .select((eb) =>
          jsonArrayFrom(
            eb
              .selectFrom('games')
              .select([
                'start',
                'duration',
                'end',
                'video_provider',
                'video_id',
                'thumbnail_url',
                'game_id',
                'game_name',
                'title',
                'chapter_image',
              ])
              .whereRef('games.vod_id', '=', 'vods.id')
          ).as('games')
        )
        .where((eb) =>
          eb.or([
            eb('created_at', '<', vod.created_at),
            eb.and([eb('created_at', '=', vod.created_at), eb('id', '<', vodId)]),
          ])
        )
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(4)
        .execute(options),
    ]);

    const prev = (prevRaw as VodNeighbor[]).slice(0, 2);
    let next = (nextRaw as VodNeighbor[]).slice(0, 4);

    if (prev.length < 2 && next.length >= 2) {
      const fill = 4 - prev.length;
      next = (nextRaw as VodNeighbor[]).slice(0, fill);
    }

    const result = {
      ...(vod as unknown as VodResponse),
      prev,
      next,
    };
    void registerVodTags(tenantId, [{ id: result.id }], cacheKey, Cache.DETAILS_TTL, 1);
    return result;
  };

  const staticData = await withStaleWhileRevalidate(
    cacheKey,
    Cache.DETAILS_TTL,
    Cache.DETAILS_TTL * CacheSwr.STALE_RATIO,
    fetcher
  );

  if (!staticData) return null;

  const volatile = await getVodVolatileCache(tenantId, staticData.id);
  if (volatile) {
    return { ...staticData, duration: volatile.duration, is_live: volatile.is_live };
  }

  return staticData;
}

/**
 * Fetch a single VOD by platform-specific ID with stale-while-revalidate caching.
 * Merges volatile data (duration, is_live) from Redis on top of cached static data.
 * Also embeds prev/next neighbors securely to prevent DB thundering herds.
 */
export async function getVodByPlatformId(
  db: ReadonlyKysely<StreamerDB>,
  tenantId: string,
  platform: Platform,
  platform_vod_id: string,
  options?: { signal?: AbortSignal }
): Promise<VodResponse | null> {
  const cacheKey = swrKeys.vodPlatform(tenantId, platform, platform_vod_id);

  const fetcher = async () => {
    const vod = await db
      .selectFrom('vods')
      .selectAll('vods')
      .select((eb) => selectVodRelations(eb))
      .where('platform', '=', platform)
      .where('platform_vod_id', '=', platform_vod_id)
      .executeTakeFirst(options);

    if (!vod) return null;

    const [prevRaw, nextRaw] = await Promise.all([
      db
        .selectFrom('vods')
        .select(['id', 'platform', 'platform_vod_id', 'title', 'duration', 'created_at'])
        .select((eb) =>
          eb
            .selectFrom('vod_uploads')
            .select('thumbnail_url')
            .whereRef('vod_uploads.vod_id', '=', 'vods.id')
            .orderBy('vod_uploads.created_at', 'asc')
            .limit(1)
            .as('thumbnail_url')
        )
        .select((eb) =>
          jsonArrayFrom(
            eb
              .selectFrom('chapters')
              .select(['name', 'image', 'start', 'duration', 'end'])
              .whereRef('chapters.vod_id', '=', 'vods.id')
          ).as('chapters')
        )
        .select((eb) =>
          jsonArrayFrom(
            eb
              .selectFrom('games')
              .select([
                'start',
                'duration',
                'end',
                'video_provider',
                'video_id',
                'thumbnail_url',
                'game_id',
                'game_name',
                'title',
                'chapter_image',
              ])
              .whereRef('games.vod_id', '=', 'vods.id')
          ).as('games')
        )
        .where((eb) =>
          eb.or([
            eb('created_at', '>', vod.created_at),
            eb.and([eb('created_at', '=', vod.created_at), eb('id', '>', vod.id)]),
          ])
        )
        .orderBy('created_at', 'asc')
        .orderBy('id', 'asc')
        .limit(4)
        .execute(options),
      db
        .selectFrom('vods')
        .select(['id', 'platform', 'platform_vod_id', 'title', 'duration', 'created_at'])
        .select((eb) =>
          eb
            .selectFrom('vod_uploads')
            .select('thumbnail_url')
            .whereRef('vod_uploads.vod_id', '=', 'vods.id')
            .orderBy('vod_uploads.created_at', 'asc')
            .limit(1)
            .as('thumbnail_url')
        )
        .select((eb) =>
          jsonArrayFrom(
            eb
              .selectFrom('chapters')
              .select(['name', 'image', 'start', 'duration', 'end'])
              .whereRef('chapters.vod_id', '=', 'vods.id')
          ).as('chapters')
        )
        .select((eb) =>
          jsonArrayFrom(
            eb
              .selectFrom('games')
              .select([
                'start',
                'duration',
                'end',
                'video_provider',
                'video_id',
                'thumbnail_url',
                'game_id',
                'game_name',
                'title',
                'chapter_image',
              ])
              .whereRef('games.vod_id', '=', 'vods.id')
          ).as('games')
        )
        .where((eb) =>
          eb.or([
            eb('created_at', '<', vod.created_at),
            eb.and([eb('created_at', '=', vod.created_at), eb('id', '<', vod.id)]),
          ])
        )
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(4)
        .execute(options),
    ]);

    const prev = (prevRaw as VodNeighbor[]).slice(0, 2);
    let next = (nextRaw as VodNeighbor[]).slice(0, 4);

    if (prev.length < 2 && next.length >= 2) {
      const fill = 4 - prev.length;
      next = (nextRaw as VodNeighbor[]).slice(0, fill);
    }

    const result = {
      ...(vod as unknown as VodResponse),
      prev,
      next,
    };
    void registerVodTags(tenantId, [{ id: result.id }], cacheKey, Cache.DETAILS_TTL, 1);
    return result;
  };

  const staticData = await withStaleWhileRevalidate(
    cacheKey,
    Cache.DETAILS_TTL,
    Cache.DETAILS_TTL * CacheSwr.STALE_RATIO,
    fetcher
  );

  if (!staticData) return null;

  const volatile = await getVodVolatileCache(tenantId, staticData.id);
  if (volatile) {
    return { ...staticData, duration: volatile.duration, is_live: volatile.is_live };
  }

  return staticData;
}

/**
 * Resolve an internal VOD ID from a legacy platform-specific VOD ID.
 * Does not use caching — this is just a lightweight ID lookup step before
 * the heavy fetchVodByIdSafe/getVodByPlatformId calls handle caching downstream.
 */
export async function resolveVodIdByPlatformVodId(
  db: DBClient,
  platform_vod_id: string,
  options?: { signal?: AbortSignal }
): Promise<number | null> {
  const record = await db
    .selectFrom('vods')
    .select('id')
    .where('platform_vod_id', '=', platform_vod_id)
    .executeTakeFirst(options);
  return record?.id ?? null;
}
