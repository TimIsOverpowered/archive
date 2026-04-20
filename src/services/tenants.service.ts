import { sql } from 'kysely';
import dayjs from 'dayjs';
import { getTenantConfig, getConfigs } from '../config/loader.js';
import { withCache } from '../utils/cache.js';
import { PLATFORMS } from '../types/platforms.js';
import { PERCENTAGE_PRECISION_MULTIPLIER, PERCENTAGE_PRECISION_DIVISOR } from '../constants.js';
import type { TenantConfig } from '../config/types.js';
import type { Kysely } from 'kysely';
import type { StreamerDB } from '../db/streamer-types';

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

export async function getTenantStats(db: Kysely<StreamerDB>, tenantId: string, cacheTtl = 60): Promise<TenantStats> {
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
      await sql`SELECT 1`.execute(db);
    } catch {
      dbStatus = 'error';
    }

    const [vodStats, uploadStats, chapterCount, thisMonthCount, uniqueGamesCount] = await Promise.all([
      db
        .selectFrom('vods')
        .select((eb) => [
          'platform',
          eb.fn.count<number>('id').as('cnt'),
          eb.fn.sum<number>('duration').as('dur'),
          eb.fn.max('created_at').as('last'),
        ])
        .groupBy('platform')
        .execute(),
      db
        .selectFrom('vod_uploads')
        .select((eb) => [eb.fn.count<number>('upload_id').as('cnt')])
        .where('status', '=', 'FAILED')
        .executeTakeFirst(),
      (
        await db
          .selectFrom('chapters')
          .select((eb) => [eb.fn.count<number>('id').as('cnt')])
          .executeTakeFirst()
      )?.cnt ?? 0,
      (
        await db
          .selectFrom('vods')
          .select((eb) => [eb.fn.count<number>('id').as('cnt')])
          .where('created_at', '>=', thisMonthStart)
          .executeTakeFirst()
      )?.cnt ?? 0,
      db.selectFrom('chapters').select('game_id').where('game_id', 'is not', null).groupBy('game_id').execute(),
    ]);

    const byPlatform: Record<string, number> = {};
    let totalDurationSeconds = 0;
    let lastVodDate: Date | null = null;

    for (const stat of vodStats) {
      byPlatform[stat.platform] = stat.cnt;
      totalDurationSeconds += stat.dur ?? 0;
      if (stat.last && (!lastVodDate || stat.last > lastVodDate)) {
        lastVodDate = stat.last;
      }
    }

    const failedUploads = uploadStats?.cnt ?? 0;
    const totalUploadsResult =
      (
        await db
          .selectFrom('vod_uploads')
          .select((eb) => [eb.fn.count<number>('upload_id').as('cnt')])
          .where('status', 'in', ['COMPLETED', 'FAILED'])
          .executeTakeFirst()
      )?.cnt ?? 0;
    const completedUploads = totalUploadsResult - failedUploads;
    const lastUploadDate =
      (
        await db
          .selectFrom('vod_uploads')
          .select('created_at')
          .where('status', '=', 'COMPLETED')
          .orderBy('created_at', 'desc')
          .limit(1)
          .executeTakeFirst()
      )?.created_at ?? null;

    const uploadSuccessRate =
      totalUploadsResult > 0
        ? Math.round((completedUploads / totalUploadsResult) * PERCENTAGE_PRECISION_MULTIPLIER) /
          PERCENTAGE_PRECISION_DIVISOR
        : 0;

    const uniqueGames = new Set(uniqueGamesCount.map((g: { game_id: string | null }) => g.game_id));

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
        totalCount: vodStats.reduce((sum: number, s: { cnt: number }) => sum + s.cnt, 0),
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
