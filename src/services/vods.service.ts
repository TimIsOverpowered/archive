import { PrismaClient } from '../../generated/streamer';
import { redisClient } from '../api/plugins/redis.plugin';

interface VodResponse {
  id: string;
  platform: string;
  title: string | null;
  duration: number;
  thumbnail_url: string | null;
  created_at: Date;
  downloaded_at: Date | null;
  vod_uploads?: Array<{
    upload_id: string;
    platform: string;
    status: string;
  }>;
  chapters?: Array<{
    name: string | null;
    duration: string | null;
    start: number;
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

const CACHE_TTL = 86400; // 24 hours
const DISABLE_CACHE = process.env.DISABLE_REDIS_CACHE === 'true';

export async function getVods(client: PrismaClient, streamerId: string, query: VodQuery): Promise<{ vods: VodResponse[]; total: number }> {
  const page = Math.max(1, query.page || 1);
  const limit = Math.min(100, Math.max(1, query.limit || 20));
  const offset = (page - 1) * limit;

  const cacheKey = `vods:${streamerId}:${JSON.stringify({ ...query, page, limit })}`;

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

  const where: Record<string, unknown> = { vod_id: { startsWith: streamerId } };

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
      some: {
        platform: 'youtube',
      },
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
      select: { vod_id: true },
    });

    const gameVodIds = games.map((g) => g.vod_id);
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
            platform: true,
            status: true,
          },
        },
        chapters: {
          select: {
            name: true,
            duration: true,
            start: true,
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

  if (!DISABLE_CACHE && redisClient) {
    try {
      await redisClient.set(cacheKey, JSON.stringify(response), { EX: CACHE_TTL });
    } catch {
      // Ignore cache errors
    }
  }

  return response;
}

export async function getVodById(client: PrismaClient, streamerId: string, vodId: string): Promise<VodResponse | null> {
  const cacheKey = `vod:${streamerId}:${vodId}`;

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
      platform: { startsWith: streamerId },
    },
    include: {
      vod_uploads: {
        select: {
          upload_id: true,
          platform: true,
          status: true,
        },
      },
      chapters: {
        select: {
          name: true,
          duration: true,
          start: true,
        },
      },
    },
  });

  if (vod) {
    const response = vod as VodResponse;

    if (!DISABLE_CACHE && redisClient) {
      try {
        await redisClient.set(cacheKey, JSON.stringify(response), { EX: CACHE_TTL });
      } catch {
        // Ignore cache errors
      }
    }

    return response;
  }

  return null;
}
