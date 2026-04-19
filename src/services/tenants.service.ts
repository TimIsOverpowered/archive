import { PrismaClient } from '../../generated/streamer/client.js';
import dayjs from 'dayjs';
import { getTenantConfig, getConfigs } from '../config/loader.js';
import { withCache } from '../utils/cache.js';
import { PLATFORMS } from '../types/platforms.js';
import { PERCENTAGE_PRECISION_MULTIPLIER, PERCENTAGE_PRECISION_DIVISOR } from '../constants.js';
import type { TenantConfig } from '../config/types.js';

export function getEnabledPlatforms(config: Pick<TenantConfig, 'twitch' | 'kick'>): string[] {
  const platforms: string[] = [];
  if (config.twitch?.enabled) platforms.push(PLATFORMS.TWITCH);
  if (config.kick?.enabled) platforms.push(PLATFORMS.KICK);
  return platforms;
}

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
  chapters: {
    count: number;
  };
  games: {
    count: number;
  };
}

export async function getTenantStats(client: PrismaClient, tenantId: string, cacheTtl = 60): Promise<TenantStats> {
  const config = getTenantConfig(tenantId);

  if (!config) {
    throw new Error('Tenant not found');
  }

  const platforms = getEnabledPlatforms(config);

  const thisMonthStart = dayjs().startOf('month').toDate();

  const cacheKey = `stats:${tenantId}`;

  return await withCache(cacheKey, cacheTtl, async () => {
    let dbStatus = 'connected';
    try {
      await client.$queryRaw`SELECT 1`;
    } catch {
      dbStatus = 'error';
    }

    const [vodStats, uploadStats, chapterCount, thisMonthCount, uniqueGamesCount] = await Promise.all([
      client.vod.groupBy({
        by: ['platform'],
        _count: { id: true },
        _sum: { duration: true },
        _max: { created_at: true },
      }),
      client.vodUpload.aggregate({
        where: { status: 'FAILED' },
        _count: { upload_id: true },
      }),
      client.chapter.count(),
      client.vod.count({
        where: { created_at: { gte: thisMonthStart } },
      }),
      client.$queryRaw<Array<{ game_id: string }>>`SELECT DISTINCT game_id FROM chapter WHERE game_id IS NOT NULL`,
    ]);

    const byPlatform: Record<string, number> = {};
    let totalDurationSeconds = 0;
    let lastVodDate: Date | null = null;

    for (const stat of vodStats) {
      byPlatform[stat.platform] = stat._count.id;
      totalDurationSeconds += stat._sum.duration ?? 0;
      if (stat._max.created_at && (!lastVodDate || stat._max.created_at > lastVodDate)) {
        lastVodDate = stat._max.created_at;
      }
    }

    const failedUploads = uploadStats._count.upload_id;
    const totalUploadsResult = await client.vodUpload.count({
      where: { status: { in: ['COMPLETED', 'FAILED'] } },
    });
    const completedUploads = totalUploadsResult - failedUploads;
    const lastUploadDateResult = await client.vodUpload.findMany({
      where: { status: 'COMPLETED' },
      orderBy: { created_at: 'desc' },
      take: 1,
      select: { created_at: true },
    });
    const lastUploadDate = lastUploadDateResult.length > 0 ? lastUploadDateResult[0].created_at : null;

    const uploadSuccessRate =
      totalUploadsResult > 0
        ? Math.round((completedUploads / totalUploadsResult) * PERCENTAGE_PRECISION_MULTIPLIER) /
          PERCENTAGE_PRECISION_DIVISOR
        : 0;

    const uniqueGames = new Set(uniqueGamesCount.map((g) => g.game_id));

    const stats: TenantStats = {
      tenant: {
        id: tenantId,
        display_name: config.displayName ?? null,
        platforms,
        created_at: config.createdAt,
      },
      database: {
        status: dbStatus,
        lastChecked: new Date(),
      },
      vods: {
        totalCount: vodStats.reduce((sum, s) => sum + s._count.id, 0),
        byPlatform,
        totalHours: Math.round((totalDurationSeconds / 3600) * 10) / 10,
        lastVodDate,
        thisMonthCount,
      },
      youtube: {
        totalUploads: completedUploads,
        failedUploads,
        lastUploadDate,
        uploadSuccessRate,
      },
      chapters: {
        count: chapterCount,
      },
      games: {
        count: uniqueGames.size,
      },
    };

    return stats;
  });
}

export async function getAllTenants(): Promise<
  Array<{
    id: string;
    display_name: string | null;
    platforms: string[];
    created_at: Date;
  }>
> {
  const configs = getConfigs();

  return configs.map((config) => ({
    id: config.id,
    display_name: config.displayName ?? null,
    platforms: getEnabledPlatforms(config),
    created_at: config.createdAt,
  }));
}
