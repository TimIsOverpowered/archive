import type { Kysely } from 'kysely';
import { getDisplayName, requirePlatformConfig } from '../../../../config/types.js';
import { findVodByPlatformId } from '../../../../db/queries/vods.js';
import type { StreamerDB, InsertableVods, SelectableVods, UpdateableVods } from '../../../../db/streamer-types.js';
import { fetchAndSaveEmotes } from '../../../../services/emotes.js';
import { getStrategy } from '../../../../services/platforms/index.js';
import { saveVodChapters } from '../../../../services/twitch/index.js';
import type { Platform } from '../../../../types/platforms.js';
import { PLATFORMS } from '../../../../types/platforms.js';
import { VodNotFoundError } from '../../../../utils/domain-errors.js';
import { type AppLogger } from '../../../../utils/logger.js';
import { triggerChatDownload } from '../../../../workers/jobs/chat.job.js';
import { TenantPlatformContext } from '../../../middleware/tenant-platform.js';

/**
 * Fetches VOD record or throws 404 if not found
 */
export async function requireVodRecord(
  db: Kysely<StreamerDB>,
  vodId: string,
  platform: Platform
): Promise<SelectableVods> {
  const record = await findVodByPlatformId(db, vodId, platform);
  if (!record) throw new VodNotFoundError(vodId);
  return record;
}

/**
 * Finds an existing VOD record or creates one from platform API metadata.
 * Returns null if the VOD cannot be found or created.
 */
export async function findOrCreateVodRecord(
  ctx: TenantPlatformContext,
  vodId: string,
  log: AppLogger
): Promise<SelectableVods | null> {
  const { db, tenantId, platform } = ctx;

  const platformConfig = requirePlatformConfig(ctx.config, platform);
  if (!platformConfig) {
    return null;
  }
  const { platformUserId, platformUsername } = platformConfig;

  const rawVodRecord = await findVodByPlatformId(db, vodId, platform);

  if (rawVodRecord) {
    log.info({ vodId }, 'Using existing VOD record');
    return rawVodRecord;
  }

  const strategy = getStrategy(platform);
  if (!strategy) {
    log.warn({ platform }, 'Unsupported platform');
    return null;
  }

  const vodMetadata = await strategy.fetchVodMetadata(vodId, ctx);
  if (!vodMetadata) {
    log.warn({ vodId, platform }, 'Failed to fetch VOD metadata');
    return null;
  }

  log.info({ vodId, platform }, 'Creating new VOD');

  const vodRecord = (await db
    .insertInto('vods')
    .values(strategy.createVodData(vodMetadata) as InsertableVods)
    .returning(['id', 'vod_id', 'platform', 'title', 'duration', 'stream_id', 'created_at'])
    .executeTakeFirst()) as SelectableVods;

  if (platform === PLATFORMS.TWITCH) {
    await saveVodChapters(ctx, vodRecord.id, vodRecord.vod_id, vodRecord.duration);
    await fetchAndSaveEmotes(ctx, vodRecord.id, platform, platformUserId);
    void triggerChatDownload({
      tenantId,
      displayName: getDisplayName(ctx.config),
      platformUserId,
      dbId: vodRecord.id,
      vodId,
      platform,
      duration: Math.round(vodRecord.duration),
      platformUsername,
    });
  }

  log.info({ vodId, platform, duration: vodRecord.duration }, 'VOD record created');

  return vodRecord;
}

/**
 * Refreshes VOD record metadata from platform API
 * Returns null if VOD cannot be found or refreshed
 */
export async function refreshVodRecord(
  ctx: TenantPlatformContext,
  vodId: string,
  dbId: number,
  platformUserId: string,
  platformUsername: string,
  log: AppLogger
): Promise<SelectableVods | null> {
  const { db, platform } = ctx;

  const platformConfig = requirePlatformConfig(ctx.config, platform);
  if (!platformConfig) {
    return null;
  }

  const existingVod = await findVodByPlatformId(db, vodId, platform);
  if (!existingVod) {
    log.warn({ vodId, platform }, 'VOD record not found for refresh');
    return null;
  }

  const strategy = getStrategy(platform);
  if (!strategy) {
    log.warn({ platform }, 'Unsupported platform');
    return null;
  }

  log.info({ vodId, platform }, 'Refreshing VOD metadata from platform');

  const vodMetadata = await strategy.fetchVodMetadata(vodId, ctx);
  if (!vodMetadata) {
    log.warn({ vodId, platform }, 'Failed to fetch VOD metadata');
    return null;
  }

  const updatedRecord = (await db
    .updateTable('vods')
    .set(strategy.updateVodData(vodMetadata) as UpdateableVods)
    .where('id', '=', dbId)
    .returning(['id', 'vod_id', 'platform', 'title', 'duration', 'stream_id', 'created_at'])
    .executeTakeFirst()) as SelectableVods;

  log.info({ vodId, platform, duration: updatedRecord.duration }, 'VOD metadata refreshed');

  if (platform === PLATFORMS.TWITCH) {
    await saveVodChapters(ctx, updatedRecord.id, updatedRecord.vod_id, updatedRecord.duration);
    await fetchAndSaveEmotes(ctx, updatedRecord.id, platform, platformUserId);
    void triggerChatDownload({
      tenantId: ctx.tenantId,
      displayName: getDisplayName(ctx.config),
      platformUserId,
      dbId: updatedRecord.id,
      vodId,
      platform,
      duration: Math.round(updatedRecord.duration),
      platformUsername,
    });
  }

  return updatedRecord;
}
