import dayjs from 'dayjs';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { configService } from '../config/tenant-config.js';
import type { TenantConfig } from '../config/types.js';
import type { StreamerDB } from '../db/streamer-types.js';
import { PLATFORMS } from '../types/platforms.js';
import { simpleKeys } from '../utils/cache-keys.js';
import { withCache } from '../utils/cache.js';
import { TenantNotFoundError } from '../utils/domain-errors.js';
import { toPercentage } from '../utils/formatting.js';

/** Return the list of enabled platform names for a tenant config. */
function getEnabledPlatforms(config: Pick<TenantConfig, 'twitch' | 'kick'>): string[] {
  const platforms: string[] = [];
  if (config.twitch?.enabled === true) platforms.push(PLATFORMS.TWITCH);
  if (config.kick?.enabled === true) platforms.push(PLATFORMS.KICK);
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
export async function getTenantStats(
  db: Kysely<StreamerDB>,
  tenantId: string,
  cacheTtl = 60,
  options?: { signal?: AbortSignal }
): Promise<TenantStats> {
  const config = await configService.get(tenantId);

  if (!config) {
    throw new TenantNotFoundError(tenantId);
  }

  const platforms = getEnabledPlatforms(config);

  const thisMonthStart = dayjs().startOf('month').toDate();

  return await withCache(simpleKeys.stats(tenantId), cacheTtl, async () => {
    const [healthCheck, vodStats, uploadStats, chapterRow, uniqueGamesCount] = await Promise.all([
      sql`SELECT 1`
        .execute(db)
        .then(() => 'connected')
        .catch(() => 'error'),
      db
        .selectFrom('vods')
        .select((eb) => [
          'platform',
          eb.fn.count('id').as('cnt'),
          eb.fn.sum('duration').as('dur'),
          eb.fn.max('created_at').as('last'),
          eb.fn.count('id').filterWhere('created_at', '>=', thisMonthStart).as('this_month_cnt'),
        ])
        .groupBy('platform')
        .execute(options),
      db
        .selectFrom('vod_uploads')
        .select((eb) => [
          eb.fn.count('upload_id').filterWhere('status', '=', 'FAILED').as('failed_cnt'),
          eb.fn.count('upload_id').filterWhere('status', 'in', ['COMPLETED', 'FAILED']).as('total_cnt'),
          eb.fn.max('created_at').filterWhere('status', '=', 'COMPLETED').as('last_upload'),
        ])
        .executeTakeFirst(options),
      db
        .selectFrom('chapters')
        .select((eb) => [eb.fn.count('id').as('cnt')])
        .executeTakeFirst(options),
      db
        .selectFrom('chapters')
        .select(sql<string>`COUNT(DISTINCT game_id)`.as('cnt'))
        .where('game_id', '!=', null)
        .executeTakeFirst(options),
    ]);

    const chapterCount = Number(chapterRow?.cnt ?? 0);
    const thisMonthCount = vodStats.reduce((sum, s) => sum + Number(s.this_month_cnt ?? 0), 0);

    const byPlatform: Record<string, number> = {};
    let totalDurationSeconds = 0;
    let lastVodDate: Date | null = null;

    for (const stat of vodStats) {
      byPlatform[stat.platform] = Number(stat.cnt);
      totalDurationSeconds += Number(stat.dur ?? 0);
      if (stat.last != null && (!lastVodDate || stat.last > lastVodDate)) {
        lastVodDate = stat.last;
      }
    }

    const failedUploads = Number(uploadStats?.failed_cnt ?? 0);
    const totalUploadsCnt = Number(uploadStats?.total_cnt ?? 0);
    const completedUploads = totalUploadsCnt - failedUploads;
    const lastUploadDate = uploadStats?.last_upload ?? null;

    const uploadSuccessRate = totalUploadsCnt > 0 ? toPercentage(completedUploads / totalUploadsCnt) : 0;

    const uniqueGameCount = Number(uniqueGamesCount?.cnt ?? 0);

    const stats: TenantStats = {
      tenant: {
        id: tenantId,
        display_name: config.displayName ?? null,
        platforms,
        created_at: config.createdAt,
      },
      database: {
        status: healthCheck,
        lastChecked: new Date(),
      },
      vods: {
        totalCount: vodStats.reduce((sum, s) => sum + Number(s.cnt), 0),
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
        count: uniqueGameCount,
      },
    };

    return stats;
  });
}

/**
 * Return all configured tenants with their enabled platforms.
 * Read from config files, not from the database.
 */
export function getAllTenants(): Pick<TenantConfig, 'id' | 'displayName' | 'createdAt'>[] {
  const configs = configService.getAll();

  return configs.map((config) => ({
    id: config.id,
    displayName: config.displayName,
    createdAt: config.createdAt,
  }));
}
