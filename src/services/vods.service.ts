import { PrismaClient, UploadStatus } from '../../generated/streamer/client';
import { withCache } from '../utils/cache.js';
import { invalidateVodCache } from './vod-cache.js';
import { VOD_DETAILS_CACHE_TTL, VOD_LIST_CACHE_TTL } from '../constants.js';
import { Platform } from '../types/platforms';

interface VodResponse {
  id: number;
  platform: Platform;
  title: string | null;
  duration: number;
  created_at: Date;
  updated_at: Date;
  is_live: boolean;
  started_at: Date | null;
  vod_uploads?: Array<{
    upload_id: string;
    type: string | null;
    duration: number;
    part: number;
    status: UploadStatus;
    thumbnail_url: string | null;
    created_at: Date;
  }>;
  chapters?: Array<{
    name: string | null;
    image: string | null;
    duration: string | null;
    start: number;
    end: number | null;
  }>;
  games?: Array<{
    start_time: number | null;
    end_time: number | null;
    video_provider: string | null;
    video_id: string | null;
    thumbnail_url: string | null;
    game_id: string | null;
    game_name: string | null;
    title: string | null;
    chapter_image: string | null;
  }>;
}

interface VodQuery {
  platform?: Platform;
  from?: string;
  to?: string;
  uploaded?: 'youtube';
  game?: string;
  page?: number;
  limit?: number;
  sort?: 'created_at' | 'duration' | 'uploaded_at';
  order?: 'asc' | 'desc';
}

export async function getVods(client: PrismaClient, tenantId: string, query: VodQuery): Promise<{ vods: VodResponse[]; total: number }> {
  const page = Math.max(1, query.page || 1);
  const limit = Math.min(100, Math.max(1, query.limit || 20));
  const offset = (page - 1) * limit;

  const cacheKey = `vods:${tenantId}:${JSON.stringify({ ...query, page, limit })}`;

  const where: Record<string, unknown> = {};

  if (query.platform) {
    where.platform = query.platform;
  }

  if (query.from || query.to) {
    where.created_at = {} as Record<string, unknown>;
    if (query.from) (where.created_at as { gte?: Date }).gte = new Date(query.from);
    if (query.to) (where.created_at as { lte?: Date }).lte = new Date(query.to);
  }

  if (query.uploaded === 'youtube') {
    where.vod_uploads = {
      some: {},
    };
  }

  if (query.game) {
    const gameLower = query.game.toLowerCase();
    const games = await client.game.findMany({
      where: {
        game_name: {
          contains: gameLower,
          mode: 'insensitive',
        },
      },
      select: { id: true },
    });

    const gameVodIds = games.map((g) => g.id);
    if (gameVodIds.length > 0) {
      where.id = { in: gameVodIds };
    } else {
      return { vods: [], total: 0 };
    }
  }

  const [vods, total] = await Promise.all([
    client.vod.findMany({
      where,
      skip: offset,
      take: limit + 1,
      orderBy: {
        [query.sort || 'created_at']: query.order || 'desc',
      },
      include: {
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
      },
    }),
    client.vod.count({ where }),
  ]);

  const hasMore = vods.length > limit;
  const resultVods = hasMore ? vods.slice(0, limit) : vods;

  const response = {
    vods: resultVods as VodResponse[],
    total,
  };

  return await withCache(cacheKey, VOD_LIST_CACHE_TTL, () => Promise.resolve(response));
}

export async function getVodById(client: PrismaClient, tenantId: string, vodId: number): Promise<VodResponse | null> {
  const cacheKey = `vod:${tenantId}:${vodId}`;

  const vod = await client.vod.findFirst({
    where: {
      id: vodId,
    },
    include: {
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
    },
  });

  if (vod) {
    const response = vod as VodResponse;
    return await withCache(cacheKey, VOD_DETAILS_CACHE_TTL, () => Promise.resolve(response));
  }

  return null;
}

export async function getVodByPlatformId(client: PrismaClient, tenantId: string, platform: Platform, platformVodId: string): Promise<VodResponse | null> {
  const cacheKey = `vod:platform:${tenantId}:${platform}:${platformVodId}`;

  const vod = await client.vod.findFirst({
    where: {
      platform,
      vod_id: platformVodId,
    },
    include: {
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
    },
  });

  if (vod) {
    const response = vod as VodResponse;
    return await withCache(cacheKey, VOD_DETAILS_CACHE_TTL, () => Promise.resolve(response));
  }

  return null;
}

export { invalidateVodCache };
