import path from 'node:path';
import { getTmpPath } from '../../../../config/env.js';
import { requirePlatformConfig } from '../../../../config/types.js';
import { Vod } from '../../../../constants.js';
import { findVodById } from '../../../../db/queries/vods.js';
import type { SelectableVods } from '../../../../db/streamer-types.js';
import type { SourceType, DownloadMethod } from '../../../../types/platforms.js';
import { DOWNLOAD_METHODS, SOURCE_TYPES } from '../../../../types/platforms.js';
import { PlatformNotConfiguredError, VodNotFoundError } from '../../../../utils/domain-errors.js';
import { extractErrorDetails } from '../../../../utils/error.js';
import { type AppLogger } from '../../../../utils/logger.js';
import {
  getTmpFilePath,
  getTmpDirPath,
  getVodFilePath,
  getVodHlsDirPath,
  getLiveFilePath,
  fileExists,
} from '../../../../utils/path.js';
import { queueFileCopy } from '../../../../workers/jobs/copy.job.js';
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
  skipFinalize?: boolean;
}

export interface EnsureVodDownloadResponse {
  filePath?: string;
  jobId: string | null;
  copyJobId?: string | undefined;
  workDir?: string | undefined;
}

type DownloadCheckResult =
  | { needed: true }
  | { needed: false; source: 'tmp' }
  | { needed: false; source: 'mp4' }
  | { needed: false; source: 'hls' };

/**
 * Ensures a VOD file exists and is valid. If missing or invalid, downloads and waits for completion.
 *
 * @returns filePath - Absolute path to the validated MP4 file
 * @throws Error if download fails or configuration is missing
 */
export async function ensureVodDownload(options: EnsureVodDownloadOptions): Promise<EnsureVodDownloadResponse> {
  const { ctx, dbId, vodId, type, downloadMethod = DOWNLOAD_METHODS.HLS, log, skipFinalize } = options;
  const { tenantId, platform, db } = ctx;

  const platformConfig = requirePlatformConfig(ctx.config, platform);
  if (!platformConfig) throw new PlatformNotConfiguredError(platform, `tenant ${tenantId}`);
  const { platformUserId, platformUsername } = platformConfig;

  const vodRecord = await findVodById(db, dbId);
  if (!vodRecord) throw new VodNotFoundError(dbId, 'vod downloads');

  const filePath =
    type === SOURCE_TYPES.LIVE
      ? getLiveFilePath({ tenantId, streamId: vodRecord.platform_stream_id ?? '' })
      : getVodFilePath({ tenantId, vodId });

  // Refresh from platform API to get authoritative duration, preventing stale
  // intermediate durations from interrupted workers from causing false mismatches.
  const refreshed = await refreshVodRecord(ctx, vodId, dbId, log);
  const durationCheckRecord = refreshed ?? vodRecord;

  if (type === SOURCE_TYPES.LIVE) {
    const liveResult = await checkValidSource(tenantId, vodId, filePath, dbId, durationCheckRecord, log);

    if (liveResult.needed) {
      log.info({ vodId, filePath, type }, 'Live VOD file not found or invalid');
      return { filePath, jobId: null };
    }

    log.debug({ filePath, source: liveResult.source }, 'Live VOD file exists with valid duration');
    return { filePath, jobId: null };
  }

  const result = await checkValidSource(tenantId, vodId, filePath, dbId, durationCheckRecord, log);

  if (result.needed) {
    log.info({ vodId, filePath, type }, 'Queuing VOD download');

    const jobId = await triggerVodDownload({
      tenantId,
      dbId,
      vodId,
      platform,
      platformUserId,
      platformUsername,
      downloadMethod,
      ...(skipFinalize !== undefined && { skipFinalize }),
    });

    const tmpFilePath = getTmpFilePath({ tenantId, vodId });
    log.info({ jobId, vodId, filePath, type }, 'VOD download queued');
    return { filePath: tmpFilePath, jobId, workDir: getTmpDirPath({ tenantId, vodId }) };
  }

  // If tmpPath is configured, ensure file is available in tmpPath for local processing
  const tmpPath = getTmpPath();
  if (tmpPath == null) {
    return { filePath, jobId: null };
  }

  const tmpFilePath = getTmpFilePath({ tenantId, vodId });

  // tmp already valid — no job needed
  if (result.source === 'tmp') {
    log.debug({ path: tmpFilePath }, 'VOD already exists in tmpPath');
    return { filePath: tmpFilePath, jobId: null, workDir: getTmpDirPath({ tenantId, vodId }) };
  }

  // Copy MP4 from storage to tmpPath
  if (result.source === 'mp4') {
    try {
      const copyJobId = await queueFileCopy({
        tenantId,
        dbId,
        vodId,
        platform,
        sourcePath: filePath,
        destPath: tmpFilePath,
      });
      log.info({ filePath, tmpFilePath, copyJobId }, 'Queued file copy from storage to tmpPath');
      return { filePath: tmpFilePath, jobId: null, copyJobId, workDir: getTmpDirPath({ tenantId, vodId }) };
    } catch (err) {
      log.warn({ error: extractErrorDetails(err).message }, 'Failed to queue file copy to tmpPath');
    }
  }

  // Copy HLS segments to tmpPath and convert in-process
  if (result.source === 'hls') {
    const hlsDirPath = getVodHlsDirPath({ tenantId, vodId });
    const tmpDirPath = getTmpDirPath({ tenantId, vodId });
    const copyJobId = await queueFileCopy({
      tenantId,
      dbId,
      vodId,
      platform,
      sourcePath: hlsDirPath,
      destPath: tmpDirPath,
      isHlsCopy: true,
    });
    log.info({ hlsDirPath, tmpDirPath, copyJobId }, 'Queued HLS copy + conversion from storage');
    return { filePath: tmpFilePath, jobId: null, copyJobId, workDir: getTmpDirPath({ tenantId, vodId }) };
  }

  return { filePath, jobId: null };
}

/**
 * Checks which source has a valid file and returns the result.
 * Priority: tmp > mp4 > hls.
 */
async function checkValidSource(
  tenantId: string,
  vodId: string,
  filePath: string,
  dbId: number,
  vodRecord: Pick<SelectableVods, 'duration'>,
  log: AppLogger
): Promise<DownloadCheckResult> {
  const tmpFilePath = getTmpFilePath({ tenantId, vodId });

  const tmpExists = await fileExists(tmpFilePath);
  if (tmpExists) {
    const meta = await getMetadata(tmpFilePath);
    const actualDuration = meta?.duration;
    if (actualDuration != null && !Number.isNaN(actualDuration)) {
      const diff = Math.abs(actualDuration - vodRecord.duration);
      if (diff <= Vod.DURATION_TOLERANCE_SECONDS) {
        log.debug({ path: tmpFilePath }, 'File exists in tmp path with valid duration');
        return { needed: false, source: 'tmp' };
      }
    }
  }

  const mp4Exists = await fileExists(filePath);
  if (mp4Exists) {
    const meta = await getMetadata(filePath);
    const actualDuration = meta?.duration;
    if (actualDuration != null && !Number.isNaN(actualDuration)) {
      const diff = Math.abs(actualDuration - vodRecord.duration);
      if (diff <= Vod.DURATION_TOLERANCE_SECONDS) {
        log.debug({ filePath }, 'MP4 file exists with valid duration');
        return { needed: false, source: 'mp4' };
      }
      log.debug(
        { dbId, expectedDuration: vodRecord.duration, actualDuration, diff },
        'Duration mismatch exceeds tolerance'
      );
    } else {
      log.warn({ filePath }, 'Could not determine MP4 file duration');
    }
  } else {
    log.debug({ filePath }, 'MP4 file does not exist');
  }

  const hlsDirPath = getVodHlsDirPath({ tenantId, vodId });
  const m3u8Path = path.join(hlsDirPath, `${vodId}.m3u8`);

  if (await fileExists(m3u8Path)) {
    const hlsMeta = await getMetadata(m3u8Path);
    const hlsDuration = hlsMeta?.duration;
    if (hlsDuration != null && !Number.isNaN(hlsDuration)) {
      const hlsDiff = Math.abs(hlsDuration - vodRecord.duration);
      if (hlsDiff <= Vod.DURATION_TOLERANCE_SECONDS) {
        log.debug({ m3u8Path }, 'HLS segments exist with valid duration');
        return { needed: false, source: 'hls' };
      }
    }
  }

  return { needed: true };
}
