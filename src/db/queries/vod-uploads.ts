import type { Kysely } from 'kysely';
import { UPLOAD_TYPES } from '../../types/platforms.ts';
import type { StreamerDB } from '../streamer-types.ts';

/**
 * Whether a VOD has a completed upload of the given type.
 * Defaults to the full-VOD YouTube upload type.
 */
export async function hasCompletedUpload(
  db: Kysely<StreamerDB>,
  vodId: number,
  type: string = UPLOAD_TYPES.VOD
): Promise<boolean> {
  const row = await db
    .selectFrom('vod_uploads')
    .select('id')
    .where('vod_id', '=', vodId)
    .where('type', '=', type)
    .where('status', '=', 'COMPLETED')
    .executeTakeFirst();

  return row != null;
}
