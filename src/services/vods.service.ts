import { z } from 'zod';
import { Prisma, PrismaClient } from '../../generated/streamer/client.js';
import { withStaleWhileRevalidate } from '../utils/cache.js';
import { VOD_DETAILS_CACHE_TTL, VOD_LIST_CACHE_TTL, VOD_VOLATILE_CACHE_TTL } from '../constants.js';
import { Platform, PLATFORM_VALUES } from '../types/platforms.js';
import { RedisService } from '../utils/redis-service.js';
import { getDisableRedisCache } from '../config/env-accessors.js';
import { registerVodTags } from './cache-tags.js';
import { getVodVolatileCache, getVodVolatileCacheBatch } from './vod-cache.js';

const inflightListQueries = new Map<string, Promise<{ vods: VodResponse[]; total: number }>>();

function buildCacheKey(...parts: (string | number | boolean | undefined | null)[]): string {
  return parts.filter((p) => p !== undefined && p !== null && p !== '').join(':');
}

function buildQueryCacheKey(tenantId: string, query: VodQuery, page: number, limit: number): string {
  const sorted = Object.keys(query).sort() as (keyof VodQuery)[];
  const queryParts = sorted.map((k) => `${k}:${query[k]}`).filter(Boolean);
  return buildCacheKey('vods', `{${tenantId}}`, ...queryParts, String(page), String(limit));
}

const VOD_INCLUDE = {
  vod_uploads: {
    select: {
      upload_id: true,
      type: true,
      duration: true,
      part: true,
      status: true,
      thumbnail_url: true,
      created_at: true,
    },
  },
  chapters: {
    select: {
      name: true,
      image: true,
      duration: true,
      start: true,
      end: true,
    },
  },
  games: {
    select: {
      start_time: true,
      end_time: true,
      video_provider: true,
      video_id: true,
      thumbnail_url: true,
      game_id: true,
      game_name: true,
      title: true,
      chapter_image: true,
    },
  },
};

export type VodResponse = Prisma.VodGetPayload<{ include: typeof VOD_INCLUDE }>;

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

export interface VodWhereInput {
  platform?: string;
  created_at?: { gte?: Date; lte?: Date };
  vod_uploads?: { some: Record<string, unknown> };
  games?: { some: { game_name: { contains: string; mode: 'insensitive' } } };
}

export function buildVodQuery(query: VodQuery): { where: VodWhereInput; orderBy: Record<string, string> } {
  const where: VodWhereInput = {};

  if (query.platform) {
    where.platform = query.platform;
  }

  if (query.from || query.to) {
    where.created_at = {};
    if (query.from) (where.created_at as { gte?: Date }).gte = new Date(query.from);
    if (query.to) (where.created_at as { lte?: Date }).lte = new Date(query.to);
  }

  if (query.uploaded === 'youtube') {
    where.vod_uploads = { some: {} };
  }

  if (query.game) {
    where.games = {
      some: {
        game_name: { contains: query.game, mode: 'insensitive' as const },
      },
    };
  }

  const orderBy = {
    [query.sort || 'created_at']: query.order || 'desc',
  };

  return { where, orderBy };
}

export async function getVods(
  client: PrismaClient,
  tenantId: string,
  query: VodQuery
): Promise<{ vods: VodResponse[]; total: number }> {
  const page = Math.max(1, query.page || 1);
  const limit = Math.min(100, Math.max(1, query.limit || 20));
  const offset = (page - 1) * limit;

  const cacheKey = buildQueryCacheKey(tenantId, query, page, limit);
  const { where, orderBy } = buildVodQuery(query);

  const redisClient = RedisService.getClient();
  const disabled = !redisClient || getDisableRedisCache();

  if (!disabled) {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        const cachedResult = JSON.parse(cached) as { vods: VodResponse[]; total: number };
        const dbIds = cachedResult.vods.map((v) => v.id);
        const volatileMap = await getVodVolatileCacheBatch(tenantId, dbIds);
        const mergedVods = cachedResult.vods.map((vod) => {
          const volatile = volatileMap.get(vod.id);
          if (volatile) {
            return { ...vod, duration: volatile.duration, is_live: volatile.is_live } as VodResponse;
          }
          return vod;
        });
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
    const [vods, total] = await Promise.all([
      client.vod.findMany({
        where,
        skip: offset,
        take: limit + 1,
        orderBy,
        include: VOD_INCLUDE,
      }),
      client.vod.count({ where }),
    ]);

    const hasMore = vods.length > limit;
    const resultVods = hasMore ? vods.slice(0, limit) : vods;
    const dbIds = resultVods.map((v) => v.id);
    const volatileMap = await getVodVolatileCacheBatch(tenantId, dbIds);

    if (!disabled) {
      const mergedVods = resultVods.map((vod) => {
        const volatile = volatileMap.get(vod.id);
        if (volatile) {
          return { ...vod, duration: volatile.duration, is_live: volatile.is_live } as VodResponse;
        }
        return vod;
      });

      const hasLiveVod = mergedVods.some((vod) => vod.is_live);
      const ttl = hasLiveVod ? VOD_VOLATILE_CACHE_TTL : VOD_LIST_CACHE_TTL;
      await registerVodTags(tenantId, mergedVods, cacheKey, JSON.stringify({ vods: mergedVods, total }), ttl);
      return { vods: mergedVods, total };
    }

    const mergedVods = resultVods.map((vod) => {
      const volatile = volatileMap.get(vod.id);
      if (volatile) {
        return { ...vod, duration: volatile.duration, is_live: volatile.is_live } as VodResponse;
      }
      return vod;
    });

    return { vods: mergedVods, total };
  })();

  inflightListQueries.set(cacheKey, fetchPromise);

  try {
    return await fetchPromise;
  } finally {
    inflightListQueries.delete(cacheKey);
  }
}

export async function getVodById(client: PrismaClient, tenantId: string, vodId: number): Promise<VodResponse | null> {
  const cacheKey = `vod:{${tenantId}}:${vodId}`;

  const fetcher = async () => {
    const vod = await client.vod.findFirst({
      where: { id: vodId },
      include: VOD_INCLUDE,
    });

    if (!vod) return null;
    return vod;
  };

  const staticData = await withStaleWhileRevalidate(
    cacheKey,
    VOD_DETAILS_CACHE_TTL,
    VOD_DETAILS_CACHE_TTL * 0.8,
    fetcher
  );

  if (!staticData) return null;

  const volatile = await getVodVolatileCache(tenantId, vodId);
  if (volatile) {
    return { ...staticData, duration: volatile.duration, is_live: volatile.is_live };
  }

  return staticData;
}

export async function getVodByPlatformId(
  client: PrismaClient,
  tenantId: string,
  platform: Platform,
  platformVodId: string
): Promise<VodResponse | null> {
  const cacheKey = `vod:platform:{${tenantId}}:${platform}:${platformVodId}`;

  const fetcher = async () => {
    const vod = await client.vod.findFirst({
      where: { platform, vod_id: platformVodId },
      include: VOD_INCLUDE,
    });

    if (!vod) return null;
    return vod;
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
    return { ...staticData, duration: volatile.duration, is_live: volatile.is_live };
  }

  return staticData;
}
