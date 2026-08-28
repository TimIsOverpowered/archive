import fsPromises from 'node:fs/promises';
import type { Job } from 'bullmq';
import type { Kysely } from 'kysely';
import type { TenantConfig } from '../config/types.ts';
import type { StreamerDB } from '../db/streamer-types.ts';
import type { Platform, SourceType } from '../types/platforms.ts';
import { SOURCE_TYPES } from '../types/platforms.ts';
import { createAutoLogger } from '../utils/auto-tenant-logger.ts';
import { initRichAlert, isAlertsEnabled } from '../utils/discord-alerts.ts';
import { ConfigNotConfiguredError } from '../utils/domain-errors.ts';
import { extractErrorDetails } from '../utils/error.ts';
import type { AppLogger } from '../utils/logger.ts';
import { getLiveFilePath, getVodFilePath, getVodHlsDirPath } from '../utils/path.ts';
import type { VodFinalizeFileJob, VodFinalizeFileResult } from './jobs/types.ts';
import { createFinalizeWorkerAlerts, safeUpdateAlert } from './utils/alert-factories.ts';
import { finalizeFile } from './utils/file-finalization.ts';
import { getJobContext } from './utils/job-context.ts';
import { wrapWorkerProcessor } from './utils/worker-wrapper.ts';
import { reapWorkDir } from './utils/workdir.ts';

interface FinalizeProcessorContext {
  log: AppLogger;
  tenantId: string;
  dbId: number;
  vodId: string;
  type: SourceType;
  platform: Platform;
  filePath: string;
  config: TenantConfig;
  db: Kysely<StreamerDB>;
  startTime: number;
  workDir?: string | undefined;
  saveMP4: boolean;
  saveHLS: boolean;
  streamId?: string | undefined;
  copiedFromStorage: boolean;
}

const buildFinalizeContext = async (job: Job<VodFinalizeFileJob>): Promise<FinalizeProcessorContext> => {
  const { tenantId, dbId, vodId, type, filePath, platform } = job.data;
  const log = createAutoLogger(String(tenantId));
  const startTime = Date.now();

  let actualFilePath = filePath;

  if (actualFilePath == null || actualFilePath === '') {
    const childResults = await job.getChildrenValues();
    const firstResult = Object.values(childResults)[0] as { finalPath?: string; filePath?: string };

    if (firstResult?.filePath != null && firstResult.filePath !== '') {
      actualFilePath = firstResult.filePath;
      log.debug({ vodId, filePath: actualFilePath }, 'Retrieved filePath from child result');
    } else if (firstResult?.finalPath != null && firstResult.finalPath !== '') {
      actualFilePath = firstResult.finalPath;
      log.debug({ vodId, filePath: actualFilePath }, 'Retrieved filePath from download job result');
    } else {
      throw new Error(
        `File path not available for vodId=${vodId}, jobId=${job.id}: child jobs may have failed or not completed`
      );
    }
  }

  const { config, db } = await getJobContext(tenantId);

  if (config == null) {
    throw new ConfigNotConfiguredError(`Finalize for tenant ${tenantId}`);
  }

  return {
    log,
    tenantId,
    dbId,
    vodId,
    type,
    platform,
    filePath: actualFilePath,
    config,
    db,
    startTime,
    workDir: job.data.workDir,
    saveMP4: job.data.saveMP4,
    saveHLS: job.data.saveHLS ?? config.settings.saveHLS ?? false,
    streamId: job.data.streamId,
    copiedFromStorage: job.data.copiedFromStorage ?? false,
  };
};

const errorMeta = (ctx: FinalizeProcessorContext, job: Job) => ({
  vodId: ctx.vodId,
  tenantId: ctx.tenantId,
  dbId: ctx.dbId,
  jobId: job.id,
  filePath: ctx.filePath,
});

const finalizeProcessor = wrapWorkerProcessor<VodFinalizeFileJob, FinalizeProcessorContext, VodFinalizeFileResult>(
  buildFinalizeContext,
  async (ctx) => {
    const destPath =
      ctx.type === SOURCE_TYPES.LIVE
        ? getLiveFilePath({ tenantId: ctx.tenantId, streamId: ctx.streamId ?? '' })
        : getVodFilePath({ tenantId: ctx.tenantId, vodId: ctx.vodId });

    // When the work dir was populated by copying an existing file from storage,
    // the canonical media is already present (and was never removed). We skip
    // writing anything back to storage and only clean up the work dir.
    const fromStorage = ctx.copiedFromStorage === true;
    const doMp4 = !fromStorage && ctx.saveMP4;
    const doHls = !fromStorage && ctx.saveHLS;

    const hlsDestDir =
      doHls && ctx.type === SOURCE_TYPES.VOD
        ? getVodHlsDirPath({ tenantId: ctx.tenantId, vodId: ctx.vodId })
        : undefined;

    const alerts = createFinalizeWorkerAlerts();
    let messageId: string | null = null;

    if (doMp4 && isAlertsEnabled()) {
      const stat = await fsPromises.stat(ctx.filePath);
      messageId = await initRichAlert(
        alerts.init(ctx.vodId, ctx.platform, ctx.type, ctx.filePath, destPath, stat.size, doMp4, doHls)
      );
    } else if (!doMp4 && isAlertsEnabled()) {
      messageId = await initRichAlert(
        alerts.init(ctx.vodId, ctx.platform, ctx.type, ctx.filePath, destPath, 0, doMp4, doHls)
      );
    }

    let tmpDirCleaned = false;

    if (doMp4) {
      let lastBucket = -1;
      const startTime = Date.now();

      await finalizeFile({
        filePath: ctx.filePath,
        destPath,
        ...(ctx.workDir != null && { tmpDir: ctx.workDir }),
        saveMP4: true,
        saveHLS: doHls,
        ...(hlsDestDir != null && { hlsDestDir }),
        ...(doHls && { excludedPath: ctx.filePath }),
        log: ctx.log,
        onProgress: (bytesCopied, totalBytes) => {
          if (messageId == null) return;

          const percent = Math.min(Math.round((bytesCopied / totalBytes) * 100), 100);
          const elapsedSeconds = (Date.now() - startTime) / 1000;
          const speed = elapsedSeconds > 0 ? bytesCopied / elapsedSeconds : 0;
          const eta = speed > 0 ? (totalBytes - bytesCopied) / speed : 0;

          const bucket = Math.floor(percent / 25) * 25;
          if (bucket > lastBucket) {
            lastBucket = bucket;
            safeUpdateAlert(
              messageId,
              alerts.progress(ctx.vodId, percent, bytesCopied, totalBytes, speed, Math.round(eta)),
              ctx.log,
              ctx.vodId
            );
          }
        },
      });

      tmpDirCleaned = true;

      const elapsedSeconds = (Date.now() - startTime) / 1000;
      const stat = await fsPromises.stat(destPath);

      if (messageId != null) {
        safeUpdateAlert(
          messageId,
          alerts.complete(
            ctx.vodId,
            ctx.platform,
            destPath,
            stat.size,
            elapsedSeconds,
            tmpDirCleaned,
            doMp4,
            doHls,
            hlsDestDir
          ),
          ctx.log,
          ctx.vodId
        );
      }
    } else if (doHls) {
      let lastBucket = -1;
      const startTime = Date.now();

      await finalizeFile({
        filePath: '',
        destPath: '',
        saveMP4: false,
        saveHLS: true,
        ...(hlsDestDir != null && { hlsDestDir }),
        ...(ctx.workDir != null && { tmpDir: ctx.workDir }),
        excludedPath: ctx.filePath,
        log: ctx.log,
        onProgress: (bytesCopied, totalBytes) => {
          if (messageId == null) return;

          const percent = Math.min(Math.round((bytesCopied / totalBytes) * 100), 100);
          const elapsedSeconds = (Date.now() - startTime) / 1000;
          const speed = elapsedSeconds > 0 ? bytesCopied / elapsedSeconds : 0;
          const eta = speed > 0 ? (totalBytes - bytesCopied) / speed : 0;

          const bucket = Math.floor(percent / 25) * 25;
          if (bucket > lastBucket) {
            lastBucket = bucket;
            safeUpdateAlert(
              messageId,
              alerts.progress(ctx.vodId, percent, bytesCopied, totalBytes, speed, Math.round(eta)),
              ctx.log,
              ctx.vodId
            );
          }
        },
      });

      tmpDirCleaned = true;

      if (messageId != null) {
        safeUpdateAlert(
          messageId,
          alerts.complete(ctx.vodId, ctx.platform, destPath, 0, 0, tmpDirCleaned, doMp4, doHls, hlsDestDir),
          ctx.log,
          ctx.vodId
        );
      }
    } else {
      if (ctx.workDir != null) {
        await fsPromises.rm(ctx.workDir, { recursive: true, force: true }).catch((err) => {
          ctx.log.warn({ workDir: ctx.workDir, error: extractErrorDetails(err).message }, 'Failed to clean up tmpDir');
        });
      }
      tmpDirCleaned = true;

      if (messageId != null) {
        safeUpdateAlert(
          messageId,
          alerts.complete(ctx.vodId, ctx.platform, destPath, 0, 0, tmpDirCleaned, doMp4, doHls, hlsDestDir),
          ctx.log,
          ctx.vodId
        );
      }
    }

    const duration = Date.now() - ctx.startTime;
    ctx.log.info({ vodId: ctx.vodId, duration }, 'Finalization completed successfully');

    return { success: true };
  },
  {
    errorMeta,
    errorAlert: (ctx, _job, errorMsg) => {
      const alerts = createFinalizeWorkerAlerts();
      const destPath =
        ctx.type === SOURCE_TYPES.LIVE
          ? getLiveFilePath({ tenantId: ctx.tenantId, streamId: ctx.streamId ?? '' })
          : getVodFilePath({ tenantId: ctx.tenantId, vodId: ctx.vodId });
      if (isAlertsEnabled()) {
        void initRichAlert(alerts.error(ctx.vodId, ctx.platform, ctx.filePath, destPath, errorMsg)).catch(() => {});
      }
      return Promise.resolve();
    },
    finally: async (ctx, _job, outcome) => {
      if (outcome.failed && !outcome.willRetry) {
        await reapWorkDir(ctx.workDir, ctx.log);
      }
    },
  }
);

export default finalizeProcessor;
