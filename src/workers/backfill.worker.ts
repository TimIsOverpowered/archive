import type { Job, Processor } from 'bullmq';
import type { TenantPlatformContext } from '../api/middleware/tenant-platform.ts';
import { processVodDownloadAndUpload } from '../api/routes/admin/utils/vod-pipeline.ts';
import { findVodByPlatformId } from '../db/queries/vods.ts';
import { hasCompletedUpload } from '../db/queries/vod-uploads.ts';
import { getStrategy } from '../services/platforms/strategy.ts';
import { DOWNLOAD_METHODS, SOURCE_TYPES, UPLOAD_MODES } from '../types/platforms.ts';
import { createAutoLogger } from '../utils/auto-tenant-logger.ts';
import { extractErrorDetails } from '../utils/error.ts';
import type { BackfillJob, BackfillResult } from './jobs/types.ts';
import { getJobContext } from './utils/job-context.ts';
import { handleWorkerError } from './utils/error-handler.ts';

/**
 * Backfill worker: fetch the streamer's full archived VOD list from the platform
 * (oldest first) and queue a download + YouTube upload for each VOD that isn't
 * already downloaded and uploaded.
 *
 * Runs outside the HTTP request so large libraries don't time out the backfill
 * endpoint. Per-VOD failures are counted and do not fail the job; fatal errors
 * (missing strategy, VOD list fetch) fail the job so it is retried. Retries are
 * safe: the per-VOD pipeline is idempotent.
 */
const backfillProcessor: Processor<BackfillJob, BackfillResult, string> = async (job: Job<BackfillJob>) => {
  const { tenantId, platform } = job.data;
  const log = createAutoLogger(tenantId);

  try {
    const { config, db } = await getJobContext(tenantId);
    const ctx: TenantPlatformContext = { tenantId, config, db, platform };

    const strategy = getStrategy(platform);
    if (!strategy) {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    log.info({ component: 'worker', jobId: job.id, platform, tenantId }, 'Starting VOD backfill');
    await job.updateProgress(0).catch(() => {});

    const allVods = await strategy.listChannelVods(ctx);

    let enqueued = 0;
    let skippedUploaded = 0;
    let failed = 0;

    for (const meta of allVods) {
      const existing = await findVodByPlatformId(db, meta.id, platform);
      if (existing != null && (await hasCompletedUpload(db, existing.id))) {
        skippedUploaded += 1;
      } else {
        try {
          const result = await processVodDownloadAndUpload(
            ctx,
            meta.id,
            { type: SOURCE_TYPES.VOD, uploadMode: UPLOAD_MODES.ALL, downloadMethod: DOWNLOAD_METHODS.HLS },
            log
          );
          if (result != null) {
            enqueued += 1;
          } else {
            failed += 1;
          }
        } catch (error) {
          log.error({ vodId: meta.id, platform, error: extractErrorDetails(error).message }, 'Backfill item failed');
          failed += 1;
        }
      }

      const processed = enqueued + skippedUploaded + failed;
      if (allVods.length > 0) {
        await job.updateProgress(Math.round((processed / allVods.length) * 100)).catch(() => {});
      }
    }

    log.info({ platform, total: allVods.length, enqueued, skippedUploaded, failed }, 'Backfill complete');

    return { success: true, total: allVods.length, enqueued, skippedUploaded, failed };
  } catch (error) {
    handleWorkerError(error, log, { platform, tenantId, jobId: job.id });
    throw error;
  }
};

export default backfillProcessor;
