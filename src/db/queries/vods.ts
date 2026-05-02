import type { Kysely } from 'kysely';
import type { StreamerDB, SelectableVods } from '../streamer-types.js';
import type { Platform } from '../../types/platforms.js';

export type VodRecord = SelectableVods;

export async function findVodById(db: Kysely<StreamerDB>, id: number): Promise<VodRecord | null> {
  return (await db.selectFrom('vods').selectAll().where('id', '=', id).executeTakeFirst()) ?? null;
}

export async function findVodByPlatformId(
  db: Kysely<StreamerDB>,
  vodId: string,
  platform: Platform
): Promise<VodRecord | null> {
  return (
    (await db
      .selectFrom('vods')
      .selectAll()
      .where('vod_id', '=', vodId)
      .where('platform', '=', platform)
      .executeTakeFirst()) ?? null
  );
}

export async function findVodByStreamId(
  db: Kysely<StreamerDB>,
  streamId: string,
  platform: Platform
): Promise<VodRecord | null> {
  return (
    (await db
      .selectFrom('vods')
      .selectAll()
      .where('stream_id', '=', streamId)
      .where('platform', '=', platform)
      .executeTakeFirst()) ?? null
  );
}

export async function findActiveLiveVod(db: Kysely<StreamerDB>, platform: Platform): Promise<VodRecord | undefined> {
  return db
    .selectFrom('vods')
    .selectAll()
    .where('platform', '=', platform)
    .where('is_live', '=', true)
    .executeTakeFirst();
}
