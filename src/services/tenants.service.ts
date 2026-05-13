import dayjs from 'dayjs';
import { sql } from 'kysely';
import type { ExpressionBuilder, Kysely } from 'kysely';
import { configService } from '../config/tenant-config.js';
import type { TenantConfig } from '../config/types.js';
import type { StreamerDB } from '../db/streamer-types.js';
import { PLATFORMS } from '../types/platforms.js';
import { simpleKeys } from '../utils/cache-keys.js';
import { withCache } from '../utils/cache.js';
import { TenantNotFoundError } from '../utils/domain-errors.js';
import { toPercentage } from '../utils/formatting.js';
import { getLogger } from '../utils/logger.js';

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
    avgDurationSeconds: number;
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
    totalRows: number;
    uniqueGames: number;
    topGame: { name: string | null; count: number } | null;
    lastDetectedAt: Date | null;
  };
  chat: {
    totalMessages: number;
    lastActivityAt: Date | null;
  };
  emotes: {
    totalDetections: number;
    byProvider: Record<string, number>;
  };
}

/**
 * Fetch aggregated statistics for a tenant with Redis caching.
 * Includes VOD counts by platform, upload success rate, chapter/game counts.
 */
export async function getTenantStats(db: Kysely<StreamerDB>, tenantId: string, cacheTtl = 60): Promise<TenantStats> {
  const config = await configService.get(tenantId);

  if (!config) {
    throw new TenantNotFoundError(tenantId);
  }

  const platforms = getEnabledPlatforms(config);

  const thisMonthStart = dayjs().startOf('month').toDate();

  return await withCache(simpleKeys.stats(tenantId), cacheTtl, async () => {
    const t0 = performance.now();

    const [
      healthCheck,
      vodStats,
      thisMonthVodStats,
      uploadStats,
      chapterRow,
      gamesStats,
      topGameRow,
      rowCount,
      avgDurationRow,
      chatStats,
      chatRowCount,
      emoteRowCount,
      emoteProviders,
    ] = await Promise.all([
      sql`SELECT 1`
        .execute(db)
        .then(() => 'connected')
        .catch((err: unknown) => {
          getLogger().error({ tenantId, error: err }, 'healthCheck query failed');
          return 'error';
        }),

      db
        .selectFrom('vods')
        .select((eb) => [
          'platform',
          eb.fn.count('id').as('cnt'),
          eb.fn.sum('duration').as('dur'),
          eb.fn.max('created_at').as('last'),
        ])
        .groupBy('platform')
        .execute()
        .catch((err: unknown) => {
          getLogger().error({ tenantId, error: err }, 'vodStats query failed');
          throw err;
        }) as Promise<{ platform: string; cnt: number | bigint; dur: number | null; last: Date | null }[]>,

      db
        .selectFrom('vods')
        .select((eb: ExpressionBuilder<StreamerDB, 'vods'>) => [eb.fn.count('id').as('cnt')])
        .where('created_at', '>=', thisMonthStart)
        .executeTakeFirst()
        .catch((err: unknown) => {
          getLogger().error({ tenantId, error: err }, 'thisMonthVodStats query failed');
          throw err;
        }) as Promise<{ cnt: number | bigint } | undefined>,

      db
        .selectFrom('vod_uploads')
        .select((eb) => [
          eb.fn.count('upload_id').filterWhere('status', '=', 'FAILED').as('failed_cnt'),
          eb.fn.count('upload_id').filterWhere('status', 'in', ['COMPLETED', 'FAILED']).as('total_cnt'),
          eb.fn.max('created_at').filterWhere('status', '=', 'COMPLETED').as('last_upload'),
        ])
        .executeTakeFirst()
        .catch((err: unknown) => {
          getLogger().error({ tenantId, error: err }, 'uploadStats query failed');
          throw err;
        }) as Promise<
        { failed_cnt: number | bigint; total_cnt: number | bigint; last_upload: Date | null } | undefined
      >,

      db
        .selectFrom('chapters')
        .select((eb) => [eb.fn.count('id').as('cnt')])
        .executeTakeFirst()
        .catch((err: unknown) => {
          getLogger().error({ tenantId, error: err }, 'chapterRow query failed');
          throw err;
        }) as Promise<{ cnt: number | bigint } | undefined>,

      db
        .selectFrom('games')
        .select((eb) => [
          eb.fn.count('game_id').distinct().as('unique_cnt'),
          eb.fn.max('created_at').as('last_detected'),
        ])
        .where('games.game_id', 'is not', null)
        .where('games.game_id', '!=', '')
        .executeTakeFirst()
        .catch((err: unknown) => {
          getLogger().error({ tenantId, error: err }, 'gamesStats query failed');
          throw err;
        }) as Promise<{ unique_cnt: number | bigint; last_detected: Date | null } | undefined>,

      db
        .selectFrom('games')
        .select(['game_name', (eb) => eb.fn.count('id').as('cnt')])
        .where('games.game_id', 'is not', null)
        .groupBy('games.game_name')
        .orderBy(sql`${sql.ref('cnt')}`, 'desc')
        .limit(1)
        .executeTakeFirst()
        .catch((err: unknown) => {
          getLogger().error({ tenantId, error: err }, 'topGame query failed');
          throw err;
        }) as Promise<{ game_name: string | null; cnt: number | bigint } | undefined>,

      sql<{ n_live_tup: number }>`SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'games'`
        .execute(db)
        .then((result) => result.rows[0] ?? { n_live_tup: 0 })
        .catch((err: unknown) => {
          getLogger().error({ tenantId, error: err }, 'gamesRowCount query failed');
          throw err;
        }),

      db
        .selectFrom('vods')
        .select((eb) => [eb.fn.avg('duration').as('avg_dur')])
        .executeTakeFirst()
        .catch((err: unknown) => {
          getLogger().error({ tenantId, error: err }, 'avgDuration query failed');
          throw err;
        }) as Promise<{ avg_dur: number | null } | undefined>,

      db
        .selectFrom('chat_messages')
        .select((eb) => [eb.fn.max('created_at').as('last_activity')])
        .executeTakeFirst()
        .catch((err: unknown) => {
          getLogger().error({ tenantId, error: err }, 'chatStats query failed');
          throw err;
        }) as Promise<{ last_activity: Date | null } | undefined>,

      sql<{ n_live_tup: number }>`SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'chat_messages'`
        .execute(db)
        .then((result) => result.rows[0] ?? { n_live_tup: 0 })
        .catch((err: unknown) => {
          getLogger().error({ tenantId, error: err }, 'chatRowCount query failed');
          throw err;
        }),

      sql<{ n_live_tup: number }>`SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'emotes'`
        .execute(db)
        .then((result) => result.rows[0] ?? { n_live_tup: 0 })
        .catch((err: unknown) => {
          getLogger().error({ tenantId, error: err }, 'emoteRowCount query failed');
          throw err;
        }),

      db
        .selectFrom('emotes')
        .select((eb) => [
          eb.fn.count('ffz_emotes').filterWhere('ffz_emotes', 'is not', null).as('ffz_cnt'),
          eb.fn.count('bttv_emotes').filterWhere('bttv_emotes', 'is not', null).as('bttv_cnt'),
          eb.fn.count('seventv_emotes').filterWhere('seventv_emotes', 'is not', null).as('seventv_cnt'),
        ])
        .executeTakeFirst()
        .catch((err: unknown) => {
          getLogger().error({ tenantId, error: err }, 'emoteProviders query failed');
          throw err;
        }) as Promise<
        { ffz_cnt: number | bigint; bttv_cnt: number | bigint; seventv_cnt: number | bigint } | undefined
      >,
    ]);

    getLogger().debug({ tenantId, ms: Math.round((performance.now() - t0) * 100) / 100 }, 'tenantStats total');

    const chapterCount = Number(chapterRow?.cnt ?? 0);
    const thisMonthCount = Number(thisMonthVodStats?.cnt ?? 0);

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

    const gamesUniqueCount = Number(gamesStats?.unique_cnt ?? 0);
    const topGame = topGameRow != null ? { name: topGameRow.game_name, count: Number(topGameRow.cnt) } : null;

    const avgDurationSeconds =
      avgDurationRow != null && avgDurationRow.avg_dur != null
        ? Math.round(Number(avgDurationRow.avg_dur) * 10) / 10
        : 0;

    const emoteProvidersObj: Record<string, number> = {};
    if (emoteProviders != null) {
      const ffz = Number(emoteProviders.ffz_cnt);
      const bttv = Number(emoteProviders.bttv_cnt);
      const seventv = Number(emoteProviders.seventv_cnt);
      if (ffz > 0) emoteProvidersObj.ffz = ffz;
      if (bttv > 0) emoteProvidersObj.bttv = bttv;
      if (seventv > 0) emoteProvidersObj.seventv = seventv;
    }

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
        avgDurationSeconds,
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
        totalRows: Number(rowCount?.n_live_tup ?? 0),
        uniqueGames: gamesUniqueCount,
        topGame,
        lastDetectedAt: gamesStats?.last_detected ?? null,
      },
      chat: {
        totalMessages: Number(chatRowCount?.n_live_tup ?? 0),
        lastActivityAt: chatStats?.last_activity ?? null,
      },
      emotes: {
        totalDetections: Number(emoteRowCount?.n_live_tup ?? 0),
        byProvider: emoteProvidersObj,
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
