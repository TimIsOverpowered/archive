import type { Kysely } from 'kysely';
import type { Platform } from '../../types/platforms.js';
import type { StreamerDB, SelectableVods } from '../streamer-types.js';

type VodByIdResult = Pick<SelectableVods, 'id' | 'platform_vod_id' | 'platform' | 'title' | 'duration' | 'created_at' | 'is_live'>;

export async function findVodById(db: Kysely<StreamerDB>, id: number): Promise<VodByIdResult | null> {
  return (
    (await db
      .selectFrom('vods')
      .select(['id', 'platform_vod_id', 'platform', 'title', 'duration', 'created_at', 'is_live'])
      .where('id', '=', id)
      .executeTakeFirst()) ?? null
  );
}

export async function findVodByPlatformId(
  db: Kysely<StreamerDB>,
  vodId: string,
  platform: Platform
): Promise<SelectableVods | null> {
  return (
    (await db
      .selectFrom('vods')
      .selectAll()
      .where('platform_vod_id', '=', vodId)
      .where('platform', '=', platform)
      .executeTakeFirst()) ?? null
  );
}

export async function findVodByStreamId(
  db: Kysely<StreamerDB>,
  streamId: string,
  platform: Platform
): Promise<SelectableVods | null> {
  return (
    (await db
      .selectFrom('vods')
      .selectAll()
      .where('platform_stream_id', '=', streamId)
      .where('platform', '=', platform)
      .executeTakeFirst()) ?? null
  );
}

export type ActiveLiveVodResult = Pick<SelectableVods, 'id' | 'platform_vod_id' | 'platform_stream_id' | 'is_live' | 'started_at'>;

export async function findActiveLiveVod(
  db: Kysely<StreamerDB>,
  platform: Platform
): Promise<ActiveLiveVodResult | undefined> {
  return db
    .selectFrom('vods')
    .select(['id', 'platform_vod_id', 'platform_stream_id', 'is_live', 'started_at'])
    .where('platform', '=', platform)
    .where('is_live', '=', true)
    .executeTakeFirst();
}
