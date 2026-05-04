import type { Kysely } from 'kysely';
import { findVodById } from '../../../../db/queries/vods.js';
import type { SelectableGames, StreamerDB } from '../../../../db/streamer-types.js';
import type { TenantContext } from '../../../../types/context.js';
import type { Platform } from '../../../../types/platforms.js';
import { GameNotFoundError } from '../../../../utils/domain-errors.js';
import { notFound, badRequest } from '../../../../utils/http-error.js';
import type { TenantPlatformContext } from '../../../middleware/tenant-platform.js';

/** Resolved game with its associated VOD and platform context. */
export interface ResolvedGameContext {
  game: SelectableGames;
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
    notFound(`VOD ${game.vod_id} not found for game ${gameId}`);
  }

  const platform = vodRecord.platform as Platform;

  if (config[platform]?.enabled !== true) {
    badRequest(`${platform} is not enabled for this tenant`);
  }

  const tenantPlatformCtx: TenantPlatformContext = {
    ...tenantCtx,
    platform,
  };

  return {
    game,
    dbId: vodRecord.id,
    vodId: vodRecord.platform_vod_id ?? '',
    platform,
    tenantPlatformCtx,
  };
}
