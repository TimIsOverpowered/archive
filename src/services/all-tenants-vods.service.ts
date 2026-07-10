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
  maxTenants?: number | undefined;
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

async function fetchRecentVodForTenant(
  tenantId: string,
  config: TenantConfig,
  platformFilter?: Platform,
  _signal?: AbortSignal
): Promise<AllTenantsVod | null> {
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

    const result = await db
      .selectFrom('vods')
      .selectAll('vods')
      .select((eb) => selectVodRelations(eb))
      .where((eb) => buildWhere(eb))
      .orderBy('vods.created_at', 'desc')
      .limit(1)
      .executeTakeFirst();

    if (!result) return null;

    return {
      tenantId,
      displayName: config.displayName ?? null,
      id: result.id,
      platform_vod_id: result.platform_vod_id,
      platform: result.platform as Platform,
      title: result.title,
      duration: result.duration,
      platform_stream_id: result.platform_stream_id,
      created_at: result.created_at,
      updated_at: result.updated_at,
      is_live: result.is_live,
      started_at: result.started_at,
      vod_uploads: result.vod_uploads as unknown as AllTenantsVod['vod_uploads'],
      chapters: result.chapters as unknown as AllTenantsVod['chapters'],
      games: result.games as unknown as AllTenantsVod['games'],
    };
  } catch (error) {
    const details = extractErrorDetails(error);
    getLogger().debug({ tenantId, error: details.message }, 'Failed to fetch recent VOD for tenant');
    return null;
  }
}

async function fetchBatch(
  tenants: Array<{ id: string; config: TenantConfig }>,
  platformFilter?: Platform,
  signal?: AbortSignal
): Promise<TenantVodResult[]> {
  const results = await Promise.allSettled(
    tenants.map(async (t) => {
      const vod = await fetchRecentVodForTenant(t.id, t.config, platformFilter, signal);
      if (!vod) return null;
      return { tenantId: t.id, displayName: t.config.displayName ?? null, vod };
    })
  );

  return results
    .filter((r): r is PromiseFulfilledResult<TenantVodResult> => r.status === 'fulfilled' && r.value !== null)
    .map((r) => r.value);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export async function getAllTenantsRecentVods(opts?: FetchRecentVodsOptions): Promise<AllTenantsVod[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 10, 1), 50);
  const maxTenants = Math.min(Math.max(opts?.maxTenants ?? 50, 1), 200);
  const platformFilter = opts?.platform;
  const signal = opts?.signal;

  const allConfigs = configService.getAll();
  const activeConfigs = allConfigs.filter((c) => c.status === 'active');
  const sorted = activeConfigs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const limited = sorted.slice(0, maxTenants);

  const tenantEntries = limited.map((c) => ({ id: c.id, config: c }));
  const concurrency = 20;
  const batches = chunk(tenantEntries, concurrency);

  const allResults: TenantVodResult[] = [];

  for (const batch of batches) {
    if (signal?.aborted === true) break;
    const batchResults = await fetchBatch(batch, platformFilter, signal);
    allResults.push(...batchResults);
  }

  const sortedVods = allResults
    .map((r) => r.vod)
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

  const truncated = sortedVods.slice(0, limit);

  const volatileMap = new Map<number, { duration: number | null; is_live: boolean }>();
  for (const vod of truncated) {
    const batch = await getVodVolatileCacheBatch(vod.tenantId, [vod.id]);
    const vol = batch.get(vod.id);
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
  const maxTenants = Math.min(Math.max(opts?.maxTenants ?? 50, 1), 200);
  const platformFilter = opts?.platform;

  const cacheKey = swrKeys.vodQuery('allTenants', { limit, maxTenants, platform: platformFilter }, 1, 1);

  return withStaleWhileRevalidate(
    cacheKey,
    Cache.VOD_LIST_TTL,
    Cache.VOD_LIST_TTL * CacheSwr.STALE_RATIO,
    () => getAllTenantsRecentVods(opts)
  );
}
