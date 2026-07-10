import type { Expression, ExpressionBuilder, SqlBool } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { configService } from '../config/tenant-config.js';
import type { TenantConfig } from '../config/types.js';
import { Cache, CacheSwr } from '../constants.js';
import { ensureClient } from '../db/streamer-client.js';
import type { StreamerDB } from '../db/streamer-types.js';
import type { AllTenantsVod } from '../types/all-tenants-vods.js';
import type { Platform } from '../types/platforms.js';
import { swrKeys } from '../utils/cache-keys.js';
import { withStaleWhileRevalidate } from '../utils/cache.js';
import { extractErrorDetails } from '../utils/error.js';
import { getLogger } from '../utils/logger.js';
import { getVodVolatileCacheBatch } from './vod-cache.js';

interface FetchRecentVodsOptions {
  limit?: number | undefined;
  platform?: Platform | undefined;
  signal?: AbortSignal | undefined;
}

interface TenantVodResult {
  tenantId: string;
  displayName: string | null;
  vod: AllTenantsVod;
}

function selectVodRelations(eb: ExpressionBuilder<StreamerDB, 'vods'>) {
  return [
    jsonArrayFrom(
      eb
        .selectFrom('vod_uploads')
        .select(['id', 'upload_id', 'type', 'duration', 'part', 'status', 'thumbnail_url', 'created_at'])
        .whereRef('vod_uploads.vod_id', '=', 'vods.id')
        .where('vod_uploads.status', '=', 'COMPLETED')
        .orderBy('vod_uploads.created_at', 'asc')
    ).as('vod_uploads'),
    jsonArrayFrom(
      eb
        .selectFrom('chapters')
        .select(['name', 'image', 'start', 'duration', 'end'])
        .whereRef('chapters.vod_id', '=', 'vods.id')
    ).as('chapters'),
    jsonArrayFrom(
      eb
        .selectFrom('games')
        .select([
          'start',
          'duration',
          'end',
          'video_provider',
          'video_id',
          'thumbnail_url',
          'game_id',
          'game_name',
          'title',
          'chapter_image',
        ])
        .whereRef('games.vod_id', '=', 'vods.id')
    ).as('games'),
  ] as const;
}

async function fetchRecentVodsForTenant(
  tenantId: string,
  config: TenantConfig,
  platformFilter?: Platform,
  _signal?: AbortSignal
): Promise<AllTenantsVod[]> {
  const db = await ensureClient(tenantId, config);

  try {
    const buildWhere = (eb: ExpressionBuilder<StreamerDB, 'vods'>): Expression<SqlBool> => {
      const conditions: Expression<SqlBool>[] = [
        eb('id', 'in', eb.selectFrom('vod_uploads').select('vod_uploads.vod_id')),
      ];

      if (platformFilter !== undefined) {
        conditions.push(eb('platform', '=', platformFilter));
      }

      return eb.and(conditions);
    };

    const results = await db
      .selectFrom('vods')
      .selectAll('vods')
      .select((eb) => selectVodRelations(eb))
      .where((eb) => buildWhere(eb))
      .orderBy('vods.created_at', 'desc')
      .limit(10)
      .execute();

    return results.map((r) => ({
      tenantId,
      displayName: config.displayName ?? null,
      id: r.id,
      platform_vod_id: r.platform_vod_id,
      platform: r.platform as Platform,
      title: r.title,
      duration: r.duration,
      platform_stream_id: r.platform_stream_id,
      created_at: r.created_at,
      updated_at: r.updated_at,
      is_live: r.is_live,
      started_at: r.started_at,
      vod_uploads: r.vod_uploads,
      chapters: r.chapters as unknown as AllTenantsVod['chapters'],
      games: r.games,
    }));
  } catch (error) {
    const details = extractErrorDetails(error);
    getLogger().debug({ tenantId, error: details.message }, 'Failed to fetch recent VOD for tenant');
    return [];
  }
}

async function fetchBatch(
  tenants: Array<{ id: string; config: TenantConfig }>,
  platformFilter?: Platform,
  signal?: AbortSignal
): Promise<TenantVodResult[]> {
  const results = await Promise.allSettled(
    tenants.map(async (t) => {
      const vods = await fetchRecentVodsForTenant(t.id, t.config, platformFilter, signal);
      return vods.map((vod) => ({ tenantId: t.id, displayName: t.config.displayName ?? null, vod }));
    })
  );

  return results
    .filter((r): r is PromiseFulfilledResult<TenantVodResult[]> => r.status === 'fulfilled')
    .flatMap((r) => r.value);
}

export async function getAllTenantsRecentVods(opts?: FetchRecentVodsOptions): Promise<AllTenantsVod[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 10, 1), 50);
  const platformFilter = opts?.platform;
  const signal = opts?.signal;

  const allConfigs = configService.getAll();
  const activeConfigs = allConfigs.filter((c) => c.status === 'active');

  const tenantEntries = activeConfigs.map((c) => ({ id: c.id, config: c }));

  const allResults: TenantVodResult[] = [];
  const concurrency = 20;

  for (let i = 0; i < tenantEntries.length; i += concurrency) {
    if (signal?.aborted === true) break;
    const batch = tenantEntries.slice(i, i + concurrency);
    const batchResults = await fetchBatch(batch, platformFilter, signal);
    allResults.push(...batchResults);
  }

  const sortedVods = allResults
    .map((r) => r.vod)
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

  const truncated = sortedVods.slice(0, limit);

  const volatileMap = new Map<number, { duration: number | null; is_live: boolean }>();
  for (const vod of truncated) {
    const volBatch = await getVodVolatileCacheBatch(vod.tenantId, [vod.id]);
    const vol = volBatch.get(vod.id);
    if (vol) {
      volatileMap.set(vod.id, vol);
    }
  }

  return truncated.map((vod) => {
    const vol = volatileMap.get(vod.id);
    if (vol) {
      return { ...vod, duration: vol.duration ?? vod.duration, is_live: vol.is_live };
    }
    return vod;
  });
}

export async function getCachedRecentVods(opts?: FetchRecentVodsOptions): Promise<AllTenantsVod[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 10, 1), 50);
  const platformFilter = opts?.platform;

  const cacheKey = swrKeys.vodQuery('globalRecentVods', { limit, platform: platformFilter }, 1, 1);

  return withStaleWhileRevalidate(
    cacheKey,
    Cache.VOD_LIST_TTL,
    Cache.VOD_LIST_TTL * CacheSwr.STALE_RATIO,
    () => getAllTenantsRecentVods(opts)
  );
}
