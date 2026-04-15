import { FastifyRequest } from 'fastify';
import { getClient } from '../../../../db/client.js';
import { getVodData, saveVodChapters, type VodData as TwitchVodData } from '../../../../services/twitch/index.js';
import { getVod as getKickVod } from '../../../../services/kick.js';
import { getVodFilePath, getLiveFilePath, fileExists } from '../../../../utils/path.js';
import { getDuration } from '../../../../workers/vod/ffmpeg.js';
import { getStandardVodQueue, type StandardVodJob } from '../../../../workers/jobs/queues.js';
import { AppLogger } from '../../../../utils/auto-tenant-logger.js';
import type { VodRecord } from '../../../../types/db.js';
import type { Platform, SourceType, DownloadMethod } from '../../../../types/platforms.js';
import { DOWNLOAD_METHODS, PLATFORMS, SOURCE_TYPES } from '../../../../types/platforms.js';
import type { TenantConfig } from '../../../../config/types';
import type { PrismaClient } from '../../../../../generated/streamer/client';
import { fetchAndSaveEmotes } from '../../../../services/emotes.js';
import { TenantContext } from '../../../middleware/tenant-platform.js';
import { parsePTDuration } from '../../../../utils/formatting.js';

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
  tenantId: string;
  dbId: number;
  vodId: string;
  platform: Platform;
  type: SourceType;
  downloadMethod?: DownloadMethod;
  config: TenantConfig;
  log: AppLogger;
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
export async function ensureVodDownload(options: EnsureVodDownloadOptions): Promise<string> {
  const { config, tenantId, dbId, vodId, platform, type, downloadMethod = DOWNLOAD_METHODS.HLS, log } = options;

  const platformUserId = platform === PLATFORMS.TWITCH ? config.twitch?.id : config.kick?.id;
  if (!platformUserId) {
    throw new Error(`Platform ${platform} not configured for tenant ${tenantId}`);
  }

  // Determine file path based on type
  const filePath = type === SOURCE_TYPES.LIVE ? getLiveFilePath({ config, streamId: vodId }) : getVodFilePath({ config, vodId });

  const needsDownload = await checkIfDownloadNeeded(filePath, dbId, tenantId, platform, log);

  if (!needsDownload) {
    log.debug({ vodId, filePath, type }, 'VOD file already exists and is valid');
    return filePath;
  }

  log.info({ vodId, filePath, type }, 'Queuing VOD download');

  const queue = getStandardVodQueue();
  const jobData: StandardVodJob = {
    tenantId,
    dbId,
    vodId,
    platform,
    downloadMethod,
  };
  await queue.add('standard_vod_download', jobData, { jobId: `download_${vodId}` });

  log.info({ vodId, filePath, type }, 'VOD download queued');
  return filePath;
}

/**
 * Checks if a VOD file needs to be downloaded (missing or duration mismatch).
 */
async function checkIfDownloadNeeded(filePath: string, dbId: number, tenantId: string, platform: Platform, log: AppLogger): Promise<boolean> {
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

  const client = getClient(tenantId);
  if (!client) {
    log.warn({ tenantId }, 'Database client not available');
    return true;
  }

  const vodRecord = await client.vod.findUnique({ where: { id: dbId } });
  if (!vodRecord) {
    log.warn({ dbId }, 'VOD record not found in database');
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
export async function ensureVodRecord(ctx: TenantContext, vodId: string, platform: Platform, log: AppLogger): Promise<VodRecord | null> {
  const { db, tenantId, config } = ctx;

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

    const duration = parsePTDuration(vodMetadata.duration);

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
    if (config?.[platform]?.id) {
      await fetchAndSaveEmotes(ctx, vodRecord.id, platform, config?.[platform]?.id);
    }
  } else if (platform === PLATFORMS.KICK) {
    if (!config?.kick?.username) {
      return null;
    }

    const vodMetadata = await getKickVod(config.kick.username, vodId);

    log.info(`Fetched Kick VOD ${vodId} from channel ${config.kick.username}`);

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
