import { requirePlatformConfig } from '../../../../config/types.js';
import { Vod } from '../../../../constants.js';
import { findVodById } from '../../../../db/queries/vods.js';
import type { SelectableVods } from '../../../../db/streamer-types.js';
import type { SourceType, DownloadMethod } from '../../../../types/platforms.js';
import { DOWNLOAD_METHODS, SOURCE_TYPES } from '../../../../types/platforms.js';
import { PlatformNotConfiguredError, VodNotFoundError } from '../../../../utils/domain-errors.js';
import { type AppLogger } from '../../../../utils/logger.js';
import { getVodFilePath, getLiveFilePath, fileExists } from '../../../../utils/path.js';
import { triggerVodDownload } from '../../../../workers/jobs/vod.job.js';
import { getMetadata } from '../../../../workers/utils/ffmpeg.js';
import { TenantPlatformContext } from '../../../middleware/tenant-platform.js';
import { refreshVodRecord } from './vod-records.js';

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

  const platformConfig = requirePlatformConfig(ctx.config, platform);
  if (!platformConfig) throw new PlatformNotConfiguredError(platform, `tenant ${tenantId}`);
  const { platformUserId, platformUsername } = platformConfig;

  const filePath =
    type === SOURCE_TYPES.LIVE ? getLiveFilePath({ config, streamId: vodId }) : getVodFilePath({ config, vodId });

  let vodRecord = await findVodById(db, dbId);
  if (vodRecord && vodRecord.duration === 0) {
    log.info({ dbId, vodId }, 'VOD duration is 0, refreshing metadata before download check');
    vodRecord = await refreshVodRecord(ctx, vodId, dbId, platformUserId, platformUsername, log);
  }

  if (!vodRecord) throw new VodNotFoundError(dbId, 'vod downloads');

  const needsDownload = await checkIfDownloadNeeded(filePath, dbId, vodRecord, log);

  if (!needsDownload) {
    log.debug({ vodId, filePath, type }, 'VOD file already exists and is valid');
    return { filePath, jobId: null };
  }

  log.info({ vodId, filePath, type }, 'Queuing VOD download');

  const jobId = await triggerVodDownload({
    tenantId,
    dbId,
    vodId,
    platform,
    platformUserId,
    platformUsername,
    downloadMethod,
  });

  log.info({ jobId, vodId, filePath, type }, 'VOD download queued');
  return { filePath, jobId };
}

/**
 * Checks if a VOD file needs to be downloaded (missing or duration mismatch).
 */
async function checkIfDownloadNeeded(
  filePath: string,
  dbId: number,
  vodRecord: Pick<SelectableVods, 'duration'>,
  log: AppLogger
): Promise<boolean> {
  const exists = await fileExists(filePath);
  if (!exists) {
    log.debug({ filePath }, 'File does not exist');
    return true;
  }

  const meta = await getMetadata(filePath);
  const actualDuration = meta?.duration;
  if (actualDuration == null || Number.isNaN(actualDuration)) {
    log.warn({ filePath }, 'Could not determine file duration');
    return true;
  }

  const expectedDuration = vodRecord.duration;
  const diff = Math.abs(actualDuration - expectedDuration);

  if (diff > Vod.DURATION_TOLERANCE_SECONDS) {
    log.debug({ dbId, expectedDuration, actualDuration, diff }, 'Duration mismatch exceeds tolerance');
    return true;
  }

  return false;
}
