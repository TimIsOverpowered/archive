import type { Kysely } from 'kysely';
import { findVodById } from '../../../../db/queries/vods.js';
import type { SelectableChapters, SelectableGames, StreamerDB } from '../../../../db/streamer-types.js';
import type { TenantContext } from '../../../../types/context.js';
import type { Platform } from '../../../../types/platforms.js';
import { ChapterNotFoundError, GameNotFoundError } from '../../../../utils/domain-errors.js';
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

/** Resolved chapter with its associated VOD and platform context. */
export interface ResolvedChapterContext {
  chapter: SelectableChapters;
  dbId: number;
  vodId: string;
  platform: Platform;
  tenantPlatformCtx: TenantPlatformContext;
}

/** Shared VOD resolution and platform validation extracted from game/chapter resolvers. */
async function resolveVodWithContext(
  db: Kysely<StreamerDB>,
  dbVodId: number,
  entityLabel: string,
  entityId: number,
  tenantCtx: TenantContext,
  config: TenantContext['config']
): Promise<{ dbId: number; vodId: string; platform: Platform; tenantPlatformCtx: TenantPlatformContext }> {
  const vodRecord = await findVodById(db, dbVodId);

  if (!vodRecord) {
    notFound(`VOD ${dbVodId} not found for ${entityLabel} ${entityId}`);
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
    dbId: vodRecord.id,
    vodId: vodRecord.platform_vod_id ?? '',
    platform,
    tenantPlatformCtx,
  };
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

  const { dbId, vodId, platform, tenantPlatformCtx } = await resolveVodWithContext(
    db,
    game.vod_id,
    'game',
    gameId,
    tenantCtx,
    config
  );

  return {
    game,
    dbId,
    vodId,
    platform,
    tenantPlatformCtx,
  };
}

/**
 * Resolves a chapter record with its associated VOD and builds a platform-aware context.
 * Validates chapter existence, VOD association, and platform configuration.
 */
export async function resolveChapterWithContext(
  chapterId: number,
  db: Kysely<StreamerDB>,
  tenantCtx: TenantContext,
  config: TenantContext['config']
): Promise<ResolvedChapterContext> {
  const chapter = await db.selectFrom('chapters').selectAll().where('id', '=', chapterId).executeTakeFirst();

  if (!chapter) {
    throw new ChapterNotFoundError(chapterId);
  }

  const { dbId, vodId, platform, tenantPlatformCtx } = await resolveVodWithContext(
    db,
    chapter.vod_id,
    'chapter',
    chapterId,
    tenantCtx,
    config
  );

  return {
    chapter,
    dbId,
    vodId,
    platform,
    tenantPlatformCtx,
  };
}
