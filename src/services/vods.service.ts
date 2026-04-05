import { PrismaClient, UploadStatus } from '../../generated/streamer/client';
import { redisClient } from '../api/plugins/redis.plugin';

interface VodResponse {
  id: string;
  platform: string;
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
  platform?: 'twitch' | 'kick';
  from?: string;
  to?: string;
  uploaded?: 'youtube';
  game?: string;
  page?: number;
  limit?: number;
  sort?: 'created_at' | 'duration' | 'uploaded_at';
  order?: 'asc' | 'desc';
}

const VODS_CACHE_TTL = 86400; // 24 hours
const DISABLE_CACHE = process.env.DISABLE_REDIS_CACHE === 'true';

export async function getVods(client: PrismaClient, tenantId: string, query: VodQuery): Promise<{ vods: VodResponse[]; total: number }> {
  const page = Math.max(1, query.page || 1);
  const limit = Math.min(100, Math.max(1, query.limit || 20));
  const offset = (page - 1) * limit;

  const cacheKey = `vods:${tenantId}:${JSON.stringify({ ...query, page, limit })}`;

  if (!DISABLE_CACHE && redisClient) {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch {
      // Ignore cache errors
    }
  }

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
    vods: resultVods as unknown as VodResponse[],
    total,
  };

  if (!DISABLE_CACHE && redisClient) {
    try {
      await redisClient.set(cacheKey, JSON.stringify(response), 'EX', VODS_CACHE_TTL);
    } catch {
      // Ignore cache errors
    }
  }

  return response;
}

export async function getVodById(client: PrismaClient, tenantId: string, vodId: string): Promise<VodResponse | null> {
  const cacheKey = `vod:${tenantId}:${vodId}`;

  if (!DISABLE_CACHE && redisClient) {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as VodResponse;
      }
    } catch {
      // Ignore cache errors
    }
  }

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
    const response = vod as unknown as VodResponse;

    if (!DISABLE_CACHE && redisClient) {
      try {
        await redisClient.set(cacheKey, JSON.stringify(response), 'EX', VODS_CACHE_TTL);
      } catch {
        // Ignore cache errors
      }
    }

    return response;
  }

  return null;
}
