import type { Kysely } from 'kysely';
import type { StreamerDB, SelectableGames } from '../streamer-types.js';

type GameByIdResult = Pick<SelectableGames, 'id' | 'vod_id' | 'start' | 'duration' | 'end'>;

export async function findGameById(db: Kysely<StreamerDB>, id: number): Promise<GameByIdResult | null> {
  return (
    (await db
      .selectFrom('games')
      .select(['id', 'vod_id', 'start', 'duration', 'end'])
      .where('id', '=', id)
      .executeTakeFirst()) ?? null
  );
}
