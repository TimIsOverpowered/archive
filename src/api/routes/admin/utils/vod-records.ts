import { saveVodChapters } from '../../../../services/twitch/index.js';
import { type AppLogger } from '../../../../utils/logger.js';
import type { VodRecord } from '../../../../types/db.js';
import type { Platform } from '../../../../types/platforms.js';
import type { Kysely } from 'kysely';
import type { StreamerDB, InsertableVods, UpdateableVods } from '../../../../db/streamer-types';
import { fetchAndSaveEmotes } from '../../../../services/emotes.js';
import { TenantPlatformContext } from '../../../middleware/tenant-platform.js';
import { triggerChatDownload } from '../../../../workers/jobs/chat.job.js';

import { getStrategy } from '../../../../services/platforms/index.js';
import { getPlatformConfig, type PlatformConfig } from '../../../../config/types.js';

/**
 * Validates and extracts platform configuration from context
 * Returns null if platform is not configured for tenant
 */
function validatePlatformConfig(
  ctx: TenantPlatformContext,
  platform: Platform
): { platformUserId: string; platformUsername: string; platformCfg: PlatformConfig } | null {
  const platformCfg = getPlatformConfig(ctx.config, platform);
  const platformUserId = platformCfg?.id;
  const platformUsername = platformCfg?.username;

  if (!platformUserId || !platformUsername) {
    return null;
  }

  return { platformUserId, platformUsername, platformCfg };
}

/**
 * Fetches VOD record or returns null if not found
 */
export async function findVodRecord(
  db: Kysely<StreamerDB>,
  vodId: string,
  platform: Platform
): Promise<VodRecord | null> {
  return (
    (await db
      .selectFrom('vods')
      .selectAll()
      .where('platform', '=', platform)
      .where('vod_id', '=', vodId)
      .executeTakeFirst()) ?? null
  );
}

/**
 * Fetches VOD record by stream_id or returns null if not found
 */
export async function findStreamRecord(
  db: Kysely<StreamerDB>,
  streamId: string,
  platform: Platform
): Promise<VodRecord | null> {
  return (
    (await db
      .selectFrom('vods')
      .selectAll()
      .where('platform', '=', platform)
      .where('stream_id', '=', streamId)
      .executeTakeFirst()) ?? null
  );
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

  const platformConfig = validatePlatformConfig(ctx, platform);
  if (!platformConfig) {
    return null;
  }
  const { platformUserId, platformCfg } = platformConfig;

  const rawVodRecord = await findVodRecord(db, vodId, platform);

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
    triggerChatDownload(
      tenantId,
      platformUserId,
      vodRecord.id,
      vodId,
      platform,
      Math.round(vodRecord.duration),
      platformCfg?.username
    );
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
    triggerChatDownload(
      tenantId,
      platformUserId,
      updatedRecord.id,
      vodId,
      platform,
      Math.round(updatedRecord.duration),
      platformUsername
    );
  }

  return updatedRecord;
}
