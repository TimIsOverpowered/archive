import { saveVodChapters } from '../../../../services/twitch/index.ts';
import type { DownloadMethod, UploadMode, SourceType } from '../../../../types/platforms.ts';
import { PLATFORMS } from '../../../../types/platforms.ts';
import type { AppLogger } from '../../../../utils/logger.ts';
import { queueYoutubeUploads } from '../../../../workers/jobs/youtube.job.ts';
import type { TenantPlatformContext } from '../../../middleware/tenant-platform.ts';
import { ensureVodDownload, type EnsureVodDownloadResponse } from './vod-downloads.ts';
import { findOrCreateVodRecord } from './vod-records.ts';

export interface VodPipelineOptions {
  type: SourceType;
  uploadMode: UploadMode;
  downloadMethod?: DownloadMethod;
  skipFinalize?: boolean;
}

/** Result of running the download + upload pipeline for a single VOD. */
export interface VodPipelineResult extends EnsureVodDownloadResponse {
  dbId: number;
  platformVodId: string;
}

/**
 * Runs the full per-VOD pipeline: ensure the VOD record exists, ensure the VOD
 * is downloaded (queuing a download if needed), fetch Twitch chapters, then
 * queue the YouTube uploads.
 *
 * Returns null when the VOD record cannot be found or created on the platform.
 */
export async function processVodDownloadAndUpload(
  ctx: TenantPlatformContext,
  platformVodId: string,
  opts: VodPipelineOptions,
  log: AppLogger
): Promise<VodPipelineResult | null> {
  const { platform, db } = ctx;

  const vodRecord = await findOrCreateVodRecord(ctx, platformVodId, log);
  if (!vodRecord) {
    return null;
  }

  const dbId = vodRecord.id;

  const download = await ensureVodDownload({
    ctx,
    dbId,
    vodId: platformVodId,
    type: opts.type,
    downloadMethod: opts.downloadMethod,
    log,
    ...(opts.skipFinalize !== undefined && { skipFinalize: opts.skipFinalize }),
  });

  if (platform === PLATFORMS.TWITCH) {
    const existingChapters = await db.selectFrom('chapters').where('vod_id', '=', dbId).selectAll().execute();
    if (existingChapters.length === 0) {
      await saveVodChapters({
        ctx,
        dbId,
        vodId: platformVodId,
        finalDurationSeconds: vodRecord.duration,
        publishUpdate: false,
      });
    }
  }

  await queueYoutubeUploads({
    ctx,
    dbId,
    vodId: platformVodId,
    filePath: download.filePath,
    platform,
    uploadMode: opts.uploadMode,
    downloadJobId: download.jobId ?? undefined,
    copyJobId: download.copyJobId,
    type: opts.type,
    workDir: download.workDir,
    forceUpload: true,
    copiedFromStorage: download.copiedFromStorage,
  });

  return { ...download, dbId, platformVodId };
}
