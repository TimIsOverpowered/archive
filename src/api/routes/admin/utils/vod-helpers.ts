import { FastifyRequest } from 'fastify';
import { getVodData, saveVodChapters, type VodData as TwitchVodData } from '../../../../services/twitch/index.js';
import { getVod as getKickVod } from '../../../../services/kick.js';
import { getVodFilePath, getLiveFilePath, fileExists } from '../../../../utils/path.js';
import { getDuration } from '../../../../workers/utils/ffmpeg.js';
import { type AppLogger } from '../../../../utils/logger.js';
import type { VodRecord } from '../../../../types/db.js';
import type { Platform, SourceType, DownloadMethod } from '../../../../types/platforms.js';
import { DOWNLOAD_METHODS, PLATFORMS, SOURCE_TYPES } from '../../../../types/platforms.js';
import type { PrismaClient } from '../../../../../generated/streamer/client';
import { fetchAndSaveEmotes } from '../../../../services/emotes.js';
import { TenantPlatformContext } from '../../../middleware/tenant-platform.js';
import { parseTwitchDuration } from '../../../../utils/formatting.js';
import { triggerVodDownload } from '../../../../workers/jobs/vod.job.js';
import { triggerChatDownload } from '../../../../workers/jobs/chat.job.js';

export interface VodCreateOptions {
  vodId: number;
  platform: Platform;
  tenantId: string;
  title?: string | null;
  createdAt?: Date;
  duration?: number;
  streamId?: string | null;
}

export interface QueueEmoteOptions {
  tenantId: string;
  vodId: number;
  platform: Platform;
  platformId: string;
  log: FastifyRequest['log'];
}

export interface EnsureVodDownloadOptions {
  ctx: TenantPlatformContext;
  dbId: number;
  vodId: string;
  type: SourceType;
  downloadMethod?: DownloadMethod;
  log: AppLogger;
}

export interface EnsureVodDownloadResponse {
  filePath?: string;
  jobId: string | null;
}

/**
 * Validates and extracts platform configuration from context
 * Returns null if platform is not configured for tenant
 */
function validatePlatformConfig(ctx: TenantPlatformContext, platform: Platform): { platformUserId: string; platformUsername: string } | null {
  const config = ctx.config?.[platform];

  const platformUserId = config?.id;
  const platformUsername = config?.username;

  if (!platformUserId || !platformUsername) {
    return null;
  }

  return { platformUserId, platformUsername };
}

/**
 * Fetches VOD record or returns null if not found
 */
export async function findVodRecord(client: PrismaClient, vodId: string, platform: Platform): Promise<VodRecord | null> {
  try {
    return await client.vod.findUnique({ where: { platform_vod_id: { platform, vod_id: vodId } } });
  } catch {
    return null;
  }
}

/**
 * Fetches VOD record by stream_id or returns null if not found
 */
export async function findStreamRecord(client: PrismaClient, streamId: string, platform: Platform): Promise<VodRecord | null> {
  try {
    return await client.vod.findFirst({ where: { platform, stream_id: streamId } });
  } catch {
    return null;
  }
}

/**
 * Ensures a VOD file exists and is valid. If missing or invalid, downloads and waits for completion.
 *
 * @returns filePath - Absolute path to the validated MP4 file
 * @throws Error if download fails or configuration is missing
 */
export async function ensureVodDownload(options: EnsureVodDownloadOptions): Promise<EnsureVodDownloadResponse> {
  const { ctx, dbId, vodId, type, downloadMethod = DOWNLOAD_METHODS.HLS, log } = options;
  const { tenantId, platform, config, db } = ctx;

  const platformConfig = validatePlatformConfig(ctx, platform);
  if (!platformConfig) throw new Error(`Platform ${platform} not configured for tenant ${tenantId}`);
  const { platformUserId, platformUsername } = platformConfig;

  // Determine file path based on type
  const filePath = type === SOURCE_TYPES.LIVE ? getLiveFilePath({ config, streamId: vodId }) : getVodFilePath({ config, vodId });

  // Check if VOD record needs metadata refresh (duration = 0)
  let vodRecord = await db.vod.findUnique({ where: { id: dbId } });
  if (vodRecord && vodRecord.duration === 0) {
    log.info({ dbId, vodId }, 'VOD duration is 0, refreshing metadata before download check');
    vodRecord = await refreshVodRecord(ctx, vodId, dbId, platformUserId, platformUsername, log);
  }

  if (!vodRecord) throw new Error(`Vod Record failed to update`);

  const needsDownload = await checkIfDownloadNeeded(filePath, dbId, vodRecord, log);

  if (!needsDownload) {
    log.debug({ vodId, filePath, type }, 'VOD file already exists and is valid');
    return { filePath, jobId: null };
  }

  log.info({ vodId, filePath, type }, 'Queuing VOD download');

  const jobId = await triggerVodDownload(tenantId, dbId, vodId, platform, platformUserId, platformUsername, downloadMethod);

  log.info({ jobId, vodId, filePath, type }, 'VOD download queued');
  return { filePath, jobId };
}

/**
 * Checks if a VOD file needs to be downloaded (missing or duration mismatch).
 */
async function checkIfDownloadNeeded(filePath: string, dbId: number, vodRecord: VodRecord, log: AppLogger): Promise<boolean> {
  const exists = await fileExists(filePath);
  if (!exists) {
    log.debug({ filePath }, 'File does not exist');
    return true;
  }

  const actualDuration = await getDuration(filePath);
  if (!actualDuration) {
    log.warn({ filePath }, 'Could not determine file duration');
    return true;
  }

  const expectedDuration = vodRecord.duration;
  const diff = Math.abs(actualDuration - expectedDuration);

  if (diff > 1) {
    log.debug({ dbId, expectedDuration, actualDuration, diff }, 'Duration mismatch exceeds tolerance');
    return true;
  }

  return false;
}

/**
 * Ensures a VOD record exists in the database, creating it from platform API if needed
 * Returns null if VOD cannot be found or created
 */
export async function ensureVodRecord(ctx: TenantPlatformContext, vodId: string, log: AppLogger): Promise<VodRecord | null> {
  const { db, tenantId, config, platform } = ctx;

  const platformConfig = validatePlatformConfig(ctx, platform);
  if (!platformConfig) {
    return null;
  }
  const { platformUserId, platformUsername } = platformConfig;

  // Try to find existing VOD record
  const rawVodRecord = await findVodRecord(db, vodId, platform);

  if (rawVodRecord) {
    log.info(`Using existing VOD record for ${vodId}`);
    return rawVodRecord;
  }

  // Create new VOD record by fetching metadata from platform API
  log.info(`Creating new VOD ${vodId} for platform ${platform}`);

  let vodRecord: VodRecord;

  if (platform === PLATFORMS.TWITCH) {
    const vodMetadata: TwitchVodData = await getVodData(vodId, tenantId);

    if (vodMetadata.user_id !== config?.twitch?.id) {
      return null;
    }

    const duration = parseTwitchDuration(vodMetadata.duration);

    vodRecord = (await db.vod.create({
      data: {
        vod_id: vodId,
        title: vodMetadata.title || null,
        created_at: new Date(vodMetadata.created_at),
        duration,
        stream_id: vodMetadata.stream_id || null,
        platform,
      },
    })) as VodRecord;

    log.info(`Created Twitch VOD ${vodId} with user_id=${vodMetadata.user_id}`);

    await saveVodChapters(ctx, vodRecord.id, vodRecord.vod_id, vodRecord.duration);
    await fetchAndSaveEmotes(ctx, vodRecord.id, platform, platformUserId);
    triggerChatDownload(tenantId, platformUserId, vodRecord.id, vodId, platform, Math.round(vodRecord.duration), config?.[platform]?.username);
  } else if (platform === PLATFORMS.KICK) {
    const vodMetadata = await getKickVod(platformUsername, vodId);

    log.info(`Fetched Kick VOD ${vodId} from channel ${platformUsername}`);

    vodRecord = (await db.vod.create({
      data: {
        vod_id: vodId,
        title: vodMetadata.session_title,
        created_at: new Date(vodMetadata.created_at),
        duration: Math.floor(Number(vodMetadata.duration) / 1000),
        stream_id: `${vodMetadata.id}`,
        platform,
      },
    })) as VodRecord;

    log.info(`Created Kick VOD ${vodId} with duration=${Number(vodMetadata.duration)}ms`);
  } else {
    return null;
  }

  return vodRecord;
}

/**
 * Refreshes VOD record metadata from platform API
 * Returns null if VOD cannot be found or refreshed
 */
export async function refreshVodRecord(ctx: TenantPlatformContext, vodId: string, dbId: number, platformUserId: string, platformUsername: string, log: AppLogger): Promise<VodRecord | null> {
  const { db, tenantId, platform } = ctx;

  log.info(`Refreshing VOD ${vodId} metadata from platform ${platform}`);

  if (platform === PLATFORMS.TWITCH) {
    const vodMetadata: TwitchVodData = await getVodData(vodId, tenantId);

    const duration = parseTwitchDuration(vodMetadata.duration);

    const updatedRecord = await db.vod.update({
      where: { id: dbId },
      data: {
        vod_id: vodId,
        title: vodMetadata.title || null,
        created_at: new Date(vodMetadata.created_at),
        duration,
        stream_id: vodMetadata.stream_id || null,
        platform,
      },
    });

    log.info(`Refreshed Twitch VOD ${vodId} with duration=${duration}s`);

    // Re-trigger chapters, emotes, and chat download
    await saveVodChapters(ctx, updatedRecord.id, updatedRecord.vod_id, updatedRecord.duration);
    await fetchAndSaveEmotes(ctx, updatedRecord.id, platform, platformUserId);
    triggerChatDownload(tenantId, platformUserId, updatedRecord.id, vodId, platform, Math.round(updatedRecord.duration), platformUsername);

    return updatedRecord;
  } else if (platform === PLATFORMS.KICK) {
    const vodMetadata = await getKickVod(platformUsername, vodId);

    log.info(`Fetched Kick VOD ${vodId} from channel ${platformUsername}`);

    const updatedRecord = (await db.vod.update({
      where: { id: dbId },
      data: {
        vod_id: vodId,
        title: vodMetadata.session_title,
        created_at: new Date(vodMetadata.created_at),
        duration: Math.floor(Number(vodMetadata.duration) / 1000),
        stream_id: `${vodMetadata.id}`,
        platform,
      },
    })) as VodRecord;

    log.info(`Refreshed Kick VOD ${vodId} with duration=${Number(vodMetadata.duration)}ms`);

    return updatedRecord;
  } else {
    log.warn({ platform }, 'Unsupported platform');
    return null;
  }
}
