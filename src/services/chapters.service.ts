import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { Cache, CacheSwr } from '../constants.js';
import { buildPagination } from '../db/queries/builders.js';
import type { StreamerDB } from '../db/streamer-types.js';
import type { SWRKey } from '../utils/cache-keys.js';
import { swrKeys } from '../utils/cache-keys.js';
import { withStaleWhileRevalidate } from '../utils/cache.js';

/** Zod schema for validating chapters library query parameters. */
export const ChapterLibraryQuerySchema = z.object({
  chapter_name: z.string().optional(),
  sort: z.enum(['count', 'chapter_name', 'recent']).default('count'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Inferred type from ChapterLibraryQuerySchema. */
export type ChapterLibraryQuery = z.infer<typeof ChapterLibraryQuerySchema>;

/** Shape of a chapter library entry. */
export interface ChapterLibraryEntry {
  game_id: string | null;
  name: string | null;
  image: string | null;
  count: number;
}

function buildQueryCacheKey(tenantId: string, query: ChapterLibraryQuery, page: number, limit: number): SWRKey {
  return swrKeys.chapterLibrary(tenantId, query, page, limit);
}

/**
 * List unique chapters grouped by game_id with VOD counts.
 * Supports filtering by chapter_name and sorting by count, name, or last_played.
 */
export async function getChaptersLibrary(
  db: Kysely<StreamerDB>,
  tenantId: string,
  query: ChapterLibraryQuery
): Promise<{ chapters: ChapterLibraryEntry[]; total: number }> {
  const { page, offset, limit } = buildPagination({ page: query.page, limit: query.limit, maxLimit: 100 });

  const cacheKey = buildQueryCacheKey(tenantId, query, page, limit);

  const fetcher = async () => {
    const [result, totalRow] = await Promise.all([
      db
        .selectFrom('chapters')
        .innerJoin('vods', 'chapters.vod_id', 'vods.id')
        .select([
          'chapters.game_id',
          'chapters.name',
          'chapters.image',
          (eb) => eb.fn.count('vods.id').distinct().as('count'),
          (eb) => eb.fn.max('vods.created_at').as('last_played'),
        ])
        .where('chapters.game_id', 'is not', null)
        .where('chapters.game_id', '!=', '')
        .where((eb) =>
          query.chapter_name != null ? eb('chapters.name', 'ilike', `%${query.chapter_name}%`) : sql`true`
        )
        .groupBy('chapters.game_id')
        .groupBy('chapters.name')
        .groupBy('chapters.image')
        .orderBy(
          query.sort === 'count' ? sql`count` : query.sort === 'chapter_name' ? 'chapters.name' : sql`last_played`,
          query.order
        )
        .limit(limit + 1)
        .offset(offset)
        .execute(),
      db
        .selectFrom('chapters')
        .innerJoin('vods', 'chapters.vod_id', 'vods.id')
        .select((eb) => [eb.fn.count('chapters.game_id').distinct().as('cnt')])
        .where('chapters.game_id', 'is not', null)
        .where('chapters.game_id', '!=', '')
        .where((eb) =>
          query.chapter_name != null ? eb('chapters.name', 'ilike', `%${query.chapter_name}%`) : sql`true`
        )
        .executeTakeFirst(),
    ]);

    const total = Number(totalRow?.cnt ?? 0);
    const hasMore = result.length > limit;
    const resultChapters = hasMore ? result.slice(0, limit) : result;
    const serialized = JSON.stringify({ chapters: resultChapters, total });
    const ttl = Cache.VOD_LIST_TTL;

    await setChaptersLibraryCache(cacheKey, serialized, ttl);

    return { chapters: resultChapters as ChapterLibraryEntry[], total };
  };

  return withStaleWhileRevalidate(cacheKey, Cache.VOD_LIST_TTL, Cache.VOD_LIST_TTL * CacheSwr.STALE_RATIO, fetcher);
}

async function setChaptersLibraryCache(key: SWRKey, value: string, ttl: number): Promise<void> {
  const { RedisService } = await import('../utils/redis-service.js');
  const client = RedisService.getActiveClient();
  if (!client) return;
  try {
    await client.set(key, value, 'EX', ttl);
  } catch {
    // Cache write failure is non-fatal
  }
}
