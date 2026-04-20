import { z } from 'zod';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import type { Kysely, ExpressionBuilder } from 'kysely';
import type { StreamerDB, DBClient } from '../db/streamer-types.js';
import { withStaleWhileRevalidate } from '../utils/cache.js';
import { VOD_DETAILS_CACHE_TTL, VOD_LIST_CACHE_TTL, VOD_VOLATILE_CACHE_TTL } from '../constants.js';
import { Platform, PLATFORM_VALUES } from '../types/platforms.js';
import { RedisService } from '../utils/redis-service.js';
import { getDisableRedisCache } from '../config/env-accessors.js';
import { registerVodTags } from './cache-tags.js';
import { getVodVolatileCache, getVodVolatileCacheBatch } from './vod-cache.js';

const inflightListQueries = new Map<string, Promise<{ vods: VodResponse[]; total: number }>>();

function applyVolatileData(
  vods: VodResponse[],
  volatileMap: Map<number, { duration: number | null; is_live: boolean }>
): VodResponse[] {
  return vods.map((vod) => {
    const volatile = volatileMap.get(vod.id);
    return volatile ? ({ ...vod, duration: volatile.duration, is_live: volatile.is_live } as VodResponse) : vod;
  });
}

function buildCacheKey(...parts: (string | number | boolean | undefined | null)[]): string {
  return parts.filter((p) => p !== undefined && p !== null && p !== '').join(':');
}

function buildQueryCacheKey(tenantId: string, query: VodQuery, page: number, limit: number): string {
  const sorted = Object.keys(query).sort() as (keyof VodQuery)[];
  const queryParts = sorted.map((k) => `${k}:${query[k]}`).filter(Boolean);
  return buildCacheKey('vods', `{${tenantId}}`, ...queryParts, String(page), String(limit));
}

export interface VodResponse {
  id: number;
  vod_id: string;
  platform: string;
  title: string | null;
  duration: number;
  stream_id: string | null;
  created_at: Date;
  updated_at: Date;
  is_live: boolean;
  started_at: Date | null;
  vod_uploads: Array<{
    upload_id: string;
    type: string | null;
    duration: number;
    part: number;
    status: string;
    thumbnail_url: string | null;
    created_at: Date;
  }>;
  chapters: Array<{
    name: string | null;
    image: string | null;
    duration: string | null;
    start: number;
    end: number | null;
  }>;
  games: Array<{
    start_time: number;
    end_time: number;
    video_provider: string | null;
    video_id: string | null;
    thumbnail_url: string | null;
    game_id: string | null;
    game_name: string | null;
    title: string | null;
    chapter_image: string | null;
  }>;
}

export const VodQuerySchema = z.object({
  platform: z.enum(PLATFORM_VALUES as [string, ...string[]]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  uploaded: z.literal('youtube').optional(),
  game: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['created_at', 'duration', 'uploaded_at']).default('created_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export type VodQuery = z.infer<typeof VodQuerySchema>;

export function buildVodQuery(query: VodQuery): {
  where: (eb: ExpressionBuilder<StreamerDB, 'vods'>) => unknown;
  orderBy: { col: string; dir: 'asc' | 'desc' };
} {
  const where = (eb: ExpressionBuilder<StreamerDB, 'vods'>) => {
    const conditions: unknown[] = [];

    if (query.platform) {
      conditions.push(eb('platform', '=', query.platform));
    }

    if (query.from) {
      conditions.push(eb('created_at', '>=', new Date(query.from)));
    }
    if (query.to) {
      conditions.push(eb('created_at', '<=', new Date(query.to)));
    }

    if (query.uploaded === 'youtube') {
      conditions.push(eb('id', 'in', eb.selectFrom('vod_uploads').select('vod_uploads.vod_id')));
    }

    if (query.game) {
      conditions.push(
        eb('id', 'in', eb.selectFrom('games').select('games.vod_id').where('game_name', 'ilike', `%${query.game}%`))
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return eb.and(conditions as any);
  };

  const orderBy = {
    col: (query.sort === 'uploaded_at' ? 'created_at' : query.sort) || 'created_at',
    dir: query.order || 'desc',
  };

  return { where, orderBy };
}

export async function getVods(
  db: Kysely<StreamerDB>,
  tenantId: string,
  query: VodQuery
): Promise<{ vods: VodResponse[]; total: number }> {
  const page = Math.max(1, query.page || 1);
  const limit = Math.min(100, Math.max(1, query.limit || 20));
  const offset = (page - 1) * limit;

  const cacheKey = buildQueryCacheKey(tenantId, query, page, limit);
  const { where, orderBy } = buildVodQuery(query);

  const redisClient = RedisService.instance?.getClient() ?? null;
  const disabled = !redisClient || getDisableRedisCache();

  if (!disabled) {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        const cachedResult = JSON.parse(cached) as { vods: VodResponse[]; total: number };
        const dbIds = cachedResult.vods.map((v) => v.id);
        const volatileMap = await getVodVolatileCacheBatch(tenantId, dbIds);
        const mergedVods = applyVolatileData(cachedResult.vods, volatileMap);
        return { vods: mergedVods, total: cachedResult.total };
      }
    } catch {
      // Cache read failed, fall through to DB
    }
  }

  if (inflightListQueries.has(cacheKey)) {
    return inflightListQueries.get(cacheKey)!;
  }

  const fetchPromise = (async () => {
    const [result, totalRow] = await Promise.all([
      db
        .selectFrom('vods')
        .selectAll('vods')
        .select((eb) => [
          jsonArrayFrom(
            eb
              .selectFrom('vod_uploads')
              .select(['upload_id', 'type', 'duration', 'part', 'status', 'thumbnail_url', 'created_at'])
              .whereRef('vod_uploads.vod_id', '=', 'vods.id')
          ).as('vod_uploads'),
          jsonArrayFrom(
            eb
              .selectFrom('chapters')
              .select(['name', 'image', 'duration', 'start', 'end'])
              .whereRef('chapters.vod_id', '=', 'vods.id')
          ).as('chapters'),
          jsonArrayFrom(
            eb
              .selectFrom('games')
              .select([
                'start_time',
                'end_time',
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
        ])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .where(where as any)
        .orderBy(orderBy.col as 'created_at' | 'duration', orderBy.dir)
        .limit(limit + 1)
        .offset(offset)
        .execute(),
      db
        .selectFrom('vods')
        .select((eb) => [eb.fn.count('id').as('cnt')])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .where(where as any)
        .executeTakeFirst(),
    ]);

    const total = Number(totalRow?.cnt ?? 0);
    const hasMore = result.length > limit;
    const resultVods = (hasMore ? result.slice(0, limit) : result) as unknown as VodResponse[];
    const dbIds = resultVods.map((v) => v.id);
    const volatileMap = await getVodVolatileCacheBatch(tenantId, dbIds);

    if (!disabled) {
      const mergedVods = applyVolatileData(resultVods, volatileMap);

      const hasLiveVod = mergedVods.some((vod) => vod.is_live);
      const ttl = hasLiveVod ? VOD_VOLATILE_CACHE_TTL : VOD_LIST_CACHE_TTL;
      await registerVodTags(tenantId, mergedVods, cacheKey, JSON.stringify({ vods: mergedVods, total }), ttl);
      return { vods: mergedVods, total };
    }

    const mergedVods = applyVolatileData(resultVods, volatileMap);

    return { vods: mergedVods, total };
  })();

  inflightListQueries.set(cacheKey, fetchPromise);

  try {
    return await fetchPromise;
  } finally {
    inflightListQueries.delete(cacheKey);
  }
}

export async function getVodById(db: DBClient, tenantId: string, vodId: number): Promise<VodResponse | null> {
  const cacheKey = `vod:{${tenantId}}:${vodId}`;

  const fetcher = async () => {
    const vod = await db
      .selectFrom('vods')
      .selectAll('vods')
      .select((eb) => [
        jsonArrayFrom(
          eb
            .selectFrom('vod_uploads')
            .select(['upload_id', 'type', 'duration', 'part', 'status', 'thumbnail_url', 'created_at'])
            .whereRef('vod_uploads.vod_id', '=', 'vods.id')
        ).as('vod_uploads'),
        jsonArrayFrom(
          eb
            .selectFrom('chapters')
            .select(['name', 'image', 'duration', 'start', 'end'])
            .whereRef('chapters.vod_id', '=', 'vods.id')
        ).as('chapters'),
        jsonArrayFrom(
          eb
            .selectFrom('games')
            .select([
              'start_time',
              'end_time',
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
      ])
      .where('id', '=', vodId)
      .executeTakeFirst();

    if (!vod) return null;
    return vod as unknown as VodResponse;
  };

  const staticData = await withStaleWhileRevalidate(
    cacheKey,
    VOD_DETAILS_CACHE_TTL,
    VOD_DETAILS_CACHE_TTL * 0.8,
    fetcher
  );

  if (!staticData) return null;

  const volatile = await getVodVolatileCache(tenantId, staticData.id);
  if (volatile) {
    return { ...staticData, duration: volatile.duration, is_live: volatile.is_live } as VodResponse;
  }

  return staticData;
}

export async function getVodByPlatformId(
  db: Kysely<StreamerDB>,
  tenantId: string,
  platform: Platform,
  platformVodId: string
): Promise<VodResponse | null> {
  const cacheKey = `vod:platform:{${tenantId}}:${platform}:${platformVodId}`;

  const fetcher = async () => {
    const vod = await db
      .selectFrom('vods')
      .selectAll('vods')
      .select((eb) => [
        jsonArrayFrom(
          eb
            .selectFrom('vod_uploads')
            .select(['upload_id', 'type', 'duration', 'part', 'status', 'thumbnail_url', 'created_at'])
            .whereRef('vod_uploads.vod_id', '=', 'vods.id')
        ).as('vod_uploads'),
        jsonArrayFrom(
          eb
            .selectFrom('chapters')
            .select(['name', 'image', 'duration', 'start', 'end'])
            .whereRef('chapters.vod_id', '=', 'vods.id')
        ).as('chapters'),
        jsonArrayFrom(
          eb
            .selectFrom('games')
            .select([
              'start_time',
              'end_time',
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
      ])
      .where('platform', '=', platform)
      .where('vod_id', '=', platformVodId)
      .executeTakeFirst();

    if (!vod) return null;
    return vod as unknown as VodResponse;
  };

  const staticData = await withStaleWhileRevalidate(
    cacheKey,
    VOD_DETAILS_CACHE_TTL,
    VOD_DETAILS_CACHE_TTL * 0.8,
    fetcher
  );

  if (!staticData) return null;

  const volatile = await getVodVolatileCache(tenantId, staticData.id);
  if (volatile) {
    return { ...staticData, duration: volatile.duration, is_live: volatile.is_live } as VodResponse;
  }

  return staticData;
}
