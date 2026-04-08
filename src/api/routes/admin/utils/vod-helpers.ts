import { FastifyRequest } from 'fastify';
import { getTenantConfig } from '../../../../config/loader';
import { getClient } from '../../../../db/client.js';

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
 * Validates tenant config and platform enablement
 */
export function validateTenantPlatform(tenantId: string, platform: 'twitch' | 'kick'): { config: ReturnType<typeof getTenantConfig> | null; error?: Error } {
  const config = getTenantConfig(tenantId);

  if (!config) {
    return { config: null, error: new Error('Tenant not found') };
  }

  if (platform === 'twitch' && !config.twitch?.enabled) {
    return { config, error: new Error('Twitch is not enabled for this tenant') };
  }

  if (platform === 'kick' && !config.kick?.enabled) {
    return { config, error: new Error('Kick is not enabled for this tenant') };
  }

  return { config };
}

/**
 * Gets and validates database client for streamer
 */
export function getValidatedClient(tenantId: string): { client: StreamerDbClient | null; error?: Error } {
  const client = getClient(tenantId);
  if (!client) return { client: null, error: new Error('Database not available') };
  return { client };
}

/**
 * Fetches VOD record or returns null if not found
 */
export async function findVodRecord(client: StreamerDbClient, vodId: number | string, platform?: 'twitch' | 'kick'): Promise<unknown> {
  try {
    if (platform) {
      return await client.vod.findUnique({ where: { platform_vod_id: { platform, vod_id: String(vodId) } } });
    }
    return await client.vod.findFirst({ where: { vod_id: String(vodId) } });
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
