import { FastifyRequest } from 'fastify';
import { getTenantConfig } from '../../../../config/loader';
import { getClient } from '../../../../db/client.js';
import type { VodData as TwitchVodData } from '../../../../services/twitch.js';
import type { KickVod } from '../../../../services/kick.js';

type StreamerDbClient = NonNullable<ReturnType<typeof getClient>>;

export interface VodCreateOptions {
  vodId: number;
  platform: 'twitch' | 'kick';
  tenantId: string;
  title?: string | null;
  createdAt?: Date;
  duration?: number;
  streamId?: string | null;
}

export interface QueueEmoteOptions {
  tenantId: string;
  vodId: number;
  platform: 'twitch' | 'kick';
  platformId: string;
  log: FastifyRequest['log'];
}

export interface EnsureVodDownloadOptions {
  tenantId: string;
  dbId: number;
  vodId: string;
  platform: 'twitch' | 'kick';
  type: 'live' | 'vod';
  downloadMethod?: 'ffmpeg' | 'hls';
  uploadMode?: 'vod' | 'all';
}

/**
 * Fetches VOD record or returns null if not found
 */
export async function findVodRecord(client: StreamerDbClient, vodId: string, platform: 'twitch' | 'kick'): Promise<VodRecord | null> {
  try {
    return await client.vod.findUnique({ where: { platform_vod_id: { platform, vod_id: vodId } } });
  } catch {
    return null;
  }
}

/**
 * Parses Twitch ISO duration format "PT2H3M15S" to seconds
 */
export function parseTwitchDuration(durationStr: string): number {
  let durStr = String(durationStr).replace('PT', '');
  let hours = 0;
  let minutes = 0;
  let secs = 0;

  if (durStr.includes('H')) {
    [hours] = durStr.split('H').map(Number);
    durStr = durStr.replace(`${Math.floor(hours)}H`, '');
  }
  if (durStr.includes('M')) {
    const mParts = durStr.split('M');
    minutes = parseInt(mParts[0]);
    secs = parseFloat(mParts[1].replace('S', ''));
  } else if (durStr.endsWith('S')) {
    secs = parseFloat(durStr.replace('S', ''));
  }

  return hours * 3600 + minutes * 60 + Math.floor(secs);
}

/**
 * Parses duration from various formats to seconds
 */
export function parseDurationToSeconds(duration: number | string, platform?: 'twitch' | 'kick'): number {
  if (typeof duration === 'number') {
    return Number(duration);
  }

  if (platform === 'twitch' && typeof duration === 'string') {
    const [hrs, mins, secs] = String(duration).split(':').map(Number);
    return hrs * 3600 + mins * 60 + secs;
  }

  if (typeof duration === 'string' && !isNaN(parseInt(duration))) {
    return parseInt(duration);
  }

  return 0;
}

/**
 * Queues emote fetch job with proper error handling
 */
export async function queueEmoteFetch(options: QueueEmoteOptions): Promise<void> {
  const { tenantId, vodId, platform, platformId, log } = options;

  void import('../../../../services/emotes')
    .then(({ fetchAndSaveEmotes }) =>
      fetchAndSaveEmotes(tenantId, vodId, platform, platformId).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`[${vodId}] Emote save failed: ${msg}`);
      })
    )
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[${vodId}] Emote save failed: ${msg}`);
    });

  log.info(`[${tenantId}] Queued async emote fetch for ${vodId} (platform=${platform}) (platformId=${platformId})`);
}

import { getVodFilePath, getLiveFilePath, fileExists } from '../../../../utils/path.js';
import { getDuration } from '../../../../utils/ffmpeg.js';
import { getVODDownloadQueue } from '../../../../jobs/queues.js';
import { createAutoLogger } from '../../../../utils/auto-tenant-logger.js';
import type { StandardVodDownloadJobData, VODDownloadResult } from '../../../../workers/vod.worker.js';

/**
 * Ensures a VOD file exists and is valid. If missing or invalid, downloads and waits for completion.
 *
 * @returns filePath - Absolute path to the validated MP4 file
 * @throws Error if download fails or configuration is missing
 */
export async function ensureVodDownload(options: EnsureVodDownloadOptions): Promise<string> {
  const { tenantId, dbId, vodId, platform, type, downloadMethod = 'hls', uploadMode } = options;
  const log = createAutoLogger(tenantId);

  const config = getTenantConfig(tenantId);
  if (!config) {
    throw new Error(`Tenant ${tenantId} not found`);
  }

  const platformUserId = platform === 'twitch' ? config.twitch?.id : config.kick?.id;
  if (!platformUserId) {
    throw new Error(`Platform ${platform} not configured for tenant ${tenantId}`);
  }

  // Determine file path based on type
  const filePath = type === 'live' ? getLiveFilePath({ tenantId, streamId: vodId }) : getVodFilePath({ tenantId, vodId });

  const needsDownload = await checkIfDownloadNeeded(filePath, dbId, tenantId, platform, log);

  if (!needsDownload) {
    log.debug({ vodId, filePath, type }, 'VOD file already exists and is valid');
    return filePath;
  }

  log.info({ vodId, filePath, type }, 'Queuing VOD download');

  const queue = getVODDownloadQueue();
  const jobData: StandardVodDownloadJobData = {
    tenantId,
    platformUserId,
    dbId,
    vodId,
    platform,
    uploadMode,
    downloadMethod,
  };
  const job = await queue.add('standard_vod_download', jobData, { jobId: `download_${vodId}` });

  // Poll job state until completed or failed (max 4 hours)
  const maxWaitTime = 4 * 60 * 60 * 1000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitTime) {
    const state = await job.getState();

    if (state === 'completed') {
      const result = job.returnvalue as unknown as VODDownloadResult | undefined;
      if (!result?.success) {
        log.error({ vodId }, 'VOD download completed but returned unsuccessful result');
        throw new Error(`VOD download completed but returned unsuccessful result for ${vodId}`);
      }
      break;
    }

    if (state === 'failed') {
      const attempts = await job.attemptsMade;
      log.error({ vodId, attempts }, 'VOD download failed');
      throw new Error(`VOD download failed for ${vodId} after ${attempts} attempts`);
    }

    // Wait 5 seconds before checking again
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  // If we exit the loop, check final state
  const finalState = await job.getState();
  if (finalState !== 'completed') {
    log.error({ vodId, finalState }, 'VOD download timed out');
    throw new Error(`VOD download timed out for ${vodId} after ${maxWaitTime / 1000 / 60} minutes`);
  }

  log.info({ vodId, filePath, type }, 'VOD download completed');
  return filePath;
}

/**
 * Checks if a VOD file needs to be downloaded (missing or duration mismatch).
 */
async function checkIfDownloadNeeded(filePath: string, dbId: number, tenantId: string, platform: 'twitch' | 'kick', log: ReturnType<typeof createAutoLogger>): Promise<boolean> {
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

  const expectedDuration = parseDurationToSeconds(vodRecord.duration, platform);
  const diff = Math.abs(actualDuration - expectedDuration);

  if (diff > 1) {
    log.debug({ dbId, expectedDuration, actualDuration, diff }, 'Duration mismatch exceeds tolerance');
    return true;
  }

  return false;
}

import type { VodRecord } from '../../../../types/db.js';

/**
 * Ensures a VOD record exists in the database, creating it from platform API if needed
 * Returns null if VOD cannot be found or created
 */
export async function ensureVodRecord(
  config: ReturnType<typeof getTenantConfig>,
  client: StreamerDbClient,
  tenantId: string,
  vodId: string,
  platform: 'twitch' | 'kick',
  log: ReturnType<typeof createAutoLogger>
): Promise<VodRecord | null> {
  // Try to find existing VOD record
  const rawVodRecord = await findVodRecord(client, vodId, platform);

  if (rawVodRecord) {
    log.info(`Using existing VOD record for ${vodId}`);
    return rawVodRecord;
  }

  // Create new VOD record by fetching metadata from platform API
  log.info(`Creating new VOD ${vodId} for platform ${platform}`);

  let vodRecord: VodRecord;

  if (platform === 'twitch') {
    const twitch = await import('../../../../services/twitch');
    const vodMetadata: TwitchVodData = await twitch.getVodData(vodId, tenantId);

    if (vodMetadata.user_id !== config?.twitch.id) {
      return null;
    }

    const durationStr = String(vodMetadata.duration);
    const durationParts: string[] = durationStr.replace('PT', '').split(/[HMS]/);
    let totalSeconds = 0;

    if (durationParts.length >= 3 && !isNaN(parseInt(durationParts[1]))) {
      totalSeconds += parseInt(durationParts[0] || '0') * 3600 + parseInt(durationParts[1]) * 60 + parseInt(durationParts[2]);
    }

    vodRecord = (await client.vod.create({
      data: {
        vod_id: vodId,
        title: vodMetadata.title || null,
        created_at: new Date(vodMetadata.created_at),
        duration: totalSeconds,
        stream_id: vodMetadata.stream_id || null,
        platform,
      },
    })) as VodRecord;

    log.info(`Created Twitch VOD ${vodId} with user_id=${vodMetadata.user_id}`);
  } else if (platform === 'kick') {
    const kick = await import('../../../../services/kick');

    if (!config?.kick?.username) {
      return null;
    }

    const vodMetadata: KickVod = await kick.getVod(config.kick.username, vodId);

    log.info(`Fetched Kick VOD ${vodId} from channel ${config.kick.username}`);

    vodRecord = (await client.vod.create({
      data: {
        vod_id: vodId,
        title: vodMetadata.session_title || null,
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
