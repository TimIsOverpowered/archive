import { getVodFilePath, getLiveFilePath, fileExists } from '../../../../utils/path.js';
import { getDuration } from '../../../../workers/utils/ffmpeg.js';
import { type AppLogger } from '../../../../utils/logger.js';
import type { VodRecord } from '../../../../types/db.js';
import type { Platform, SourceType, DownloadMethod } from '../../../../types/platforms.js';
import { DOWNLOAD_METHODS, SOURCE_TYPES } from '../../../../types/platforms.js';
import { VOD_DURATION_TOLERANCE_SECONDS } from '../../../../constants.js';
import { TenantPlatformContext } from '../../../middleware/tenant-platform.js';
import { triggerVodDownload } from '../../../../workers/jobs/vod.job.js';
import { refreshVodRecord } from './vod-records.js';
import { getPlatformConfig } from '../../../../config/types.js';

export interface EnsureVodDownloadOptions {
  ctx: TenantPlatformContext;
  dbId: number;
  vodId: string;
  type: SourceType;
  downloadMethod?: DownloadMethod | undefined;
  log: AppLogger;
}

export interface EnsureVodDownloadResponse {
  filePath?: string;
  jobId: string | null;
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

  const filePath =
    type === SOURCE_TYPES.LIVE ? getLiveFilePath({ config, streamId: vodId }) : getVodFilePath({ config, vodId });

  let vodRecord = (await db.selectFrom('vods').selectAll().where('id', '=', dbId).executeTakeFirst()) ?? null;
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

  const jobId = await triggerVodDownload(
    tenantId,
    dbId,
    vodId,
    platform,
    platformUserId,
    platformUsername,
    downloadMethod
  );

  log.info({ jobId, vodId, filePath, type }, 'VOD download queued');
  return { filePath, jobId };
}

/**
 * Checks if a VOD file needs to be downloaded (missing or duration mismatch).
 */
async function checkIfDownloadNeeded(
  filePath: string,
  dbId: number,
  vodRecord: VodRecord,
  log: AppLogger
): Promise<boolean> {
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

  if (diff > VOD_DURATION_TOLERANCE_SECONDS) {
    log.debug({ dbId, expectedDuration, actualDuration, diff }, 'Duration mismatch exceeds tolerance');
    return true;
  }

  return false;
}

function validatePlatformConfig(
  ctx: TenantPlatformContext,
  platform: Platform
): { platformUserId: string; platformUsername: string } | null {
  const platformCfg = getPlatformConfig(ctx.config, platform);
  const platformUserId = platformCfg?.id;
  const platformUsername = platformCfg?.username;

  if (!platformUserId || !platformUsername) {
    return null;
  }

  return { platformUserId, platformUsername };
}
