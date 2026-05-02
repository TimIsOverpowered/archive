import { saveVodChapters } from '../../../../services/twitch/index.js';
import { type AppLogger } from '../../../../utils/logger.js';
import type { VodRecord } from '../../../../types/db.js';
import type { Platform } from '../../../../types/platforms.js';
import type { Kysely } from 'kysely';
import type { StreamerDB, InsertableVods, UpdateableVods } from '../../../../db/streamer-types.js';
import { fetchAndSaveEmotes } from '../../../../services/emotes.js';
import { TenantPlatformContext } from '../../../middleware/tenant-platform.js';
import { triggerChatDownload } from '../../../../workers/jobs/chat.job.js';

import { getStrategy } from '../../../../services/platforms/index.js';
import { getDisplayName, requirePlatformConfig } from '../../../../config/types.js';
import { VodNotFoundError } from '../../../../utils/domain-errors.js';
import { findVodByPlatformId, findVodByStreamId } from '../../../../db/queries/vods.js';

/**
 * Fetches VOD record or throws 404 if not found
 */
export async function requireVodRecord(db: Kysely<StreamerDB>, vodId: string, platform: Platform): Promise<VodRecord> {
  const record = await findVodByPlatformId(db, vodId, platform);
  if (!record) throw new VodNotFoundError(vodId);
  return record;
}

/**
 * Fetches VOD record by stream_id or returns null if not found
 */
export async function findStreamRecord(
  db: Kysely<StreamerDB>,
  streamId: string,
  platform: Platform
): Promise<VodRecord | null> {
  return findVodByStreamId(db, streamId, platform);
}

/**
 * Ensures a VOD record exists in the database, creating it from platform API if needed
 * Returns null if VOD cannot be found or created
 */
export async function ensureVodRecord(
  ctx: TenantPlatformContext,
  vodId: string,
  log: AppLogger
): Promise<VodRecord | null> {
  const { db, tenantId, platform } = ctx;

  const platformConfig = requirePlatformConfig(ctx.config, platform);
  if (!platformConfig) {
    return null;
  }
  const { platformUserId, platformUsername } = platformConfig;

  const rawVodRecord = await findVodByPlatformId(db, vodId, platform);

  if (rawVodRecord) {
    log.info(`Using existing VOD record for ${vodId}`);
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

  log.info(`Creating new VOD ${vodId} for platform ${platform}`);

  const vodRecord = (await db
    .insertInto('vods')
    .values(strategy.createVodData(vodMetadata) as InsertableVods)
    .returning(['id', 'vod_id', 'platform', 'title', 'duration', 'stream_id', 'created_at'])
    .executeTakeFirst()) as VodRecord;

  if (platform === 'twitch') {
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
): Promise<VodRecord | null> {
  const { db, tenantId, platform } = ctx;

  const strategy = getStrategy(platform);
  if (!strategy) {
    log.warn({ platform }, 'Unsupported platform');
    return null;
  }

  log.info(`Refreshing VOD ${vodId} metadata from platform ${platform}`);

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
    .executeTakeFirst()) as VodRecord;

  log.info({ vodId, platform, duration: updatedRecord.duration }, 'VOD metadata refreshed');

  if (platform === 'twitch') {
    await saveVodChapters(ctx, updatedRecord.id, updatedRecord.vod_id, updatedRecord.duration);
    await fetchAndSaveEmotes(ctx, updatedRecord.id, platform, platformUserId);
    void triggerChatDownload({
      tenantId,
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
