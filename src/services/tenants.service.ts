import { sql } from 'kysely';
import dayjs from 'dayjs';
import { getTenantConfig, getConfigs } from '../config/loader.js';
import { withCache } from '../utils/cache.js';
import { PLATFORMS } from '../types/platforms.js';
import { PERCENTAGE_PRECISION_MULTIPLIER, PERCENTAGE_PRECISION_DIVISOR } from '../constants.js';
import type { TenantConfig } from '../config/types.js';
import type { Kysely } from 'kysely';
import type { StreamerDB } from '../db/streamer-types.js';

/** Return the list of enabled platform names for a tenant config. */
export function getEnabledPlatforms(config: Pick<TenantConfig, 'twitch' | 'kick'>): string[] {
  const platforms: string[] = [];
  if (config.twitch?.enabled) platforms.push(PLATFORMS.TWITCH);
  if (config.kick?.enabled) platforms.push(PLATFORMS.KICK);
  return platforms;
}

/** Aggregated statistics for a tenant including VODs, uploads, chapters, and games. */
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

/**
 * Fetch aggregated statistics for a tenant with Redis caching.
 * Includes VOD counts by platform, upload success rate, chapter/game counts.
 */
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

    const [vodStats, uploadStats, chapterRow, thisMonthRow, uniqueGamesCount, totalUploadsRow, lastUploadRow] =
      await Promise.all([
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
        db
          .selectFrom('chapters')
          .select((eb) => [eb.fn.count<number>('id').as('cnt')])
          .executeTakeFirst(),
        db
          .selectFrom('vods')
          .select((eb) => [eb.fn.count<number>('id').as('cnt')])
          .where('created_at', '>=', thisMonthStart)
          .executeTakeFirst(),
        db.selectFrom('chapters').select('game_id').where('game_id', 'is not', null).groupBy('game_id').execute(),
        db
          .selectFrom('vod_uploads')
          .select((eb) => [eb.fn.count<number>('upload_id').as('cnt')])
          .where('status', 'in', ['COMPLETED', 'FAILED'])
          .executeTakeFirst(),
        db
          .selectFrom('vod_uploads')
          .select((eb) => [eb.fn.max('created_at').as('maxCreatedAt')])
          .where('status', '=', 'COMPLETED')
          .executeTakeFirst(),
      ]);

    const chapterCount = chapterRow?.cnt ?? 0;
    const thisMonthCount = thisMonthRow?.cnt ?? 0;

    const byPlatform: Record<string, number> = {};
    let totalDurationSeconds = 0;
    let lastVodDate: Date | null = null;

    for (const stat of vodStats) {
      byPlatform[stat.platform] = Number(stat.cnt);
      totalDurationSeconds += Number(stat.dur ?? 0);
      if (stat.last && (!lastVodDate || stat.last > lastVodDate)) {
        lastVodDate = stat.last;
      }
    }

    const failedUploads = Number(uploadStats?.cnt ?? 0);
    const totalUploadsCnt = Number(totalUploadsRow?.cnt ?? 0);
    const completedUploads = totalUploadsCnt - failedUploads;
    const lastUploadDate = lastUploadRow?.maxCreatedAt ?? null;

    const uploadSuccessRate =
      totalUploadsCnt > 0
        ? Math.round((completedUploads / totalUploadsCnt) * PERCENTAGE_PRECISION_MULTIPLIER) /
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
        totalCount: vodStats.reduce((sum: number, s: { cnt: number | string }) => sum + Number(s.cnt), 0),
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

/**
 * Return all configured tenants with their enabled platforms.
 * Read from config files, not from the database.
 */
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
