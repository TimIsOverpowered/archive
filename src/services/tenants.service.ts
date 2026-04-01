import { PrismaClient } from '../../generated/streamer/client';
import { metaClient } from '../db/meta-client';
import { redisClient } from '../api/plugins/redis.plugin';

const STATS_CACHE_TTL = parseInt(process.env.STATS_CACHE_TTL || '60', 10);
const DISABLE_CACHE = process.env.DISABLE_REDIS_CACHE === 'true';

interface TenantStats {
  tenant: {
    id: string;
    display_name: string | null;
    platforms: string[];
    created_at: Date;
  };
  database: {
    status: string;
    lastChecked: Date;
  };
  vods: {
    totalCount: number;
    byPlatform: Record<string, number>;
    totalHours: number;
    lastVodDate: Date | null;
    thisMonthCount: number;
  };
  youtube: {
    totalUploads: number;
    failedUploads: number;
    lastUploadDate: Date | null;
    uploadSuccessRate: number;
  };
  chat: {
    totalMessages: number;
    messagesThisMonth: number;
  };
  chapters: {
    totalChapters: number;
    gamesCount: number;
  };
}

export async function getTenantStats(client: PrismaClient, streamerId: string): Promise<TenantStats> {
  const cacheKey = `stats:${streamerId}`;

  if (!DISABLE_CACHE && redisClient) {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as TenantStats;
      }
    } catch {
      // Ignore cache errors
    }
  }

  const tenant = await metaClient.tenant.findFirst({
    where: { id: streamerId },
  });

  if (!tenant) {
    throw new Error('Tenant not found');
  }

  let dbStatus = 'connected';
  try {
    await client.$queryRaw`SELECT 1`;
  } catch {
    dbStatus = 'error';
  }

  const platforms: string[] = [];
  const twitch = tenant.twitch as Record<string, unknown> | null;
  const youtube = tenant.youtube as Record<string, unknown> | null;
  const kick = tenant.kick as Record<string, unknown> | null;

  if (twitch?.username) platforms.push('twitch');
  if (youtube?.apiKey || youtube?.auth) platforms.push('youtube');
  if (kick?.username) platforms.push('kick');

  const [vods, vodUploads, chatMessages, chapters] = await Promise.all([
    client.vod.findMany({ where: { platform: { startsWith: streamerId } } }),
    client.vodUpload.findMany({
      where: {
        vod: { platform: { startsWith: streamerId } },
      },
    }),
    client.chatMessage.count({
      where: { vod_id: { startsWith: streamerId } },
    }),
    client.chapter.findMany({
      where: { vod: { platform: { startsWith: streamerId } } },
    }),
  ]);

  const byPlatform: Record<string, number> = {};
  vods.forEach((vod) => {
    byPlatform[vod.platform] = (byPlatform[vod.platform] || 0) + 1;
  });

  const totalDurationSeconds = vods.reduce((sum, vod) => sum + vod.duration, 0);
  const lastVodDate = vods.length > 0 ? new Date(Math.max(...vods.map((v) => v.created_at.getTime()))) : null;

  const thisMonthStart = new Date();
  thisMonthStart.setDate(1);
  thisMonthStart.setHours(0, 0, 0, 0);
  const thisMonthVods = vods.filter((v) => v.created_at >= thisMonthStart).length;

  const completedUploads = vodUploads.filter((u) => u.status === 'COMPLETED');
  const failedUploads = vodUploads.filter((u) => u.status === 'FAILED');
  const totalUploads = completedUploads.length + failedUploads.length;
  const lastUploadDate = completedUploads.length > 0 ? new Date(Math.max(...completedUploads.map((u) => u.created_at.getTime()))) : null;

  const uploadSuccessRate = totalUploads > 0 ? Math.round((completedUploads.length / totalUploads) * 1000) / 10 : 0;

  const uniqueGames = new Set(
    chapters
      .filter((c) => c.game_id)
      .map((c) => c.game_id)
      .filter(Boolean)
  );

  const thisMonthChatStart = new Date();
  thisMonthChatStart.setMonth(thisMonthChatStart.getMonth() - 1);

  const messagesThisMonth = await client.chatMessage.count({
    where: {
      vod_id: { startsWith: streamerId },
      createdAt: { gte: thisMonthChatStart },
    },
  });

  const stats: TenantStats = {
    tenant: {
      id: streamerId,
      display_name: tenant.displayName,
      platforms,
      created_at: tenant.createdAt,
    },
    database: {
      status: dbStatus,
      lastChecked: new Date(),
    },
    vods: {
      totalCount: vods.length,
      byPlatform,
      totalHours: Math.round((totalDurationSeconds / 3600) * 10) / 10,
      lastVodDate,
      thisMonthCount: thisMonthVods,
    },
    youtube: {
      totalUploads: completedUploads.length,
      failedUploads: failedUploads.length,
      lastUploadDate,
      uploadSuccessRate,
    },
    chat: {
      totalMessages: chatMessages,
      messagesThisMonth,
    },
    chapters: {
      totalChapters: chapters.length,
      gamesCount: uniqueGames.size,
    },
  };

  if (!DISABLE_CACHE && redisClient) {
    try {
      await redisClient.set(cacheKey, JSON.stringify(stats), { EX: STATS_CACHE_TTL });
    } catch {
      // Ignore cache errors
    }
  }

  return stats;
}

export async function getAllTenants(): Promise<
  Array<{
    id: string;
    display_name: string | null;
    platforms: string[];
    created_at: Date;
  }>
> {
  const tenants = await metaClient.tenant.findMany({
    select: {
      id: true,
      displayName: true,
      twitch: true,
      kick: true,
      youtube: true,
      createdAt: true,
    },
  });

  return tenants.map((t) => {
    const platforms: string[] = [];
    const twitch = t.twitch as Record<string, unknown> | null;
    const youtube = t.youtube as Record<string, unknown> | null;
    const kick = t.kick as Record<string, unknown> | null;

    if (twitch?.username) platforms.push('twitch');
    if (youtube?.apiKey || youtube?.auth) platforms.push('youtube');
    if (kick?.username) platforms.push('kick');

    return {
      id: t.id,
      display_name: t.displayName,
      platforms,
      created_at: t.createdAt,
    };
  });
}
