import { HttpError } from '../../../../utils/http-error.js';
import type { Platform } from '../../../../types/platforms.js';
import type { TenantContext } from '../../../../types/context.js';
import { GameNotFoundError } from '../../../../utils/domain-errors.js';
import type { Kysely } from 'kysely';
import type { StreamerDB } from '../../../../db/streamer-types.js';
import type { TenantPlatformContext } from '../../../middleware/tenant-platform.js';
import { findVodById } from '../../../../db/queries/vods.js';

/** Resolved game with its associated VOD and platform context. */
export interface ResolvedGameContext {
  game: {
    id: number;
    vod_id: number;
    game_name?: string;
    start_time: number;
    end_time: number;
    game_id?: string;
    title?: string;
  };
  dbId: number;
  vodId: string;
  platform: Platform;
  tenantPlatformCtx: TenantPlatformContext;
}

/**
 * Resolves a game record with its associated VOD and builds a platform-aware context.
 * Validates game existence, VOD association, and platform configuration.
 */
export async function resolveGameWithContext(
  gameId: number,
  db: Kysely<StreamerDB>,
  tenantCtx: TenantContext,
  config: TenantContext['config']
): Promise<ResolvedGameContext> {
  const game = await db.selectFrom('games').selectAll().where('id', '=', gameId).executeTakeFirst();

  if (!game) {
    throw new GameNotFoundError(gameId);
  }

  const vodRecord = await findVodById(db, game.vod_id);

  if (!vodRecord) {
    throw new HttpError(404, `VOD ${game.vod_id} not found for game ${gameId}`, 'NOT_FOUND');
  }

  const platform = vodRecord.platform as Platform;

  if (config[platform]?.enabled !== true) {
    throw new HttpError(400, `${platform} is not enabled for this tenant`, 'BAD_REQUEST');
  }

  const tenantPlatformCtx: TenantPlatformContext = {
    ...tenantCtx,
    platform,
  };

  const gameRecord: ResolvedGameContext['game'] = {
    id: game.id,
    vod_id: game.vod_id,
    start_time: game.start_time,
    end_time: game.end_time,
    ...(game.game_name != null && { game_name: game.game_name }),
    ...(game.game_id != null && { game_id: game.game_id }),
    ...(game.title != null && { title: game.title }),
  };

  return {
    game: gameRecord,
    dbId: vodRecord.id,
    vodId: String(vodRecord.vod_id),
    platform,
    tenantPlatformCtx,
  };
}
