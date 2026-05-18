import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { Job } from 'bullmq';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { initRichAlert, isAlertsEnabled } from '../utils/discord-alerts.js';
import type { AppLogger } from '../utils/logger.js';
import type { CopyFileJob, CopyFileResult } from './jobs/types.js';
import { createCopyWorkerAlerts, safeUpdateAlert } from './utils/alert-factories.js';
import { wrapWorkerProcessor } from './utils/worker-wrapper.js';

interface CopyFileProcessorContext {
  job: Job<CopyFileJob>;
  log: AppLogger;
  tenantId: string;
  dbId: number;
  vodId: string;
  sourcePath: string;
  destPath: string;
}

const buildCopyFileContext = async (job: Job<CopyFileJob>): Promise<CopyFileProcessorContext> => {
  const { tenantId, dbId, vodId, sourcePath, destPath } = job.data;
  return Promise.resolve({
    job,
    log: createAutoLogger(String(tenantId)),
    tenantId,
    dbId,
    vodId,
    sourcePath,
    destPath,
  });
};

const errorMeta = (ctx: CopyFileProcessorContext, job: Job) => ({
  vodId: ctx.vodId,
  tenantId: ctx.tenantId,
  dbId: ctx.dbId,
  jobId: job.id,
  sourcePath: ctx.sourcePath,
  destPath: ctx.destPath,
});

const CHUNK_SIZE = 1024 * 1024;

const copyFileProcessor = wrapWorkerProcessor<CopyFileJob, CopyFileProcessorContext, CopyFileResult>(
  buildCopyFileContext,
  async (ctx) => {
    const { job, log, vodId, sourcePath, destPath } = ctx;
    const destDir = path.dirname(destPath);
    await fsPromises.mkdir(destDir, { recursive: true });

    const stat = await fsPromises.stat(sourcePath);
    const fileSize = stat.size;
    const alerts = createCopyWorkerAlerts();

    let messageId: string | null = null;
    if (isAlertsEnabled()) {
      messageId = await initRichAlert(alerts.init(vodId, sourcePath, destPath, fileSize));
    }

    const startTime = Date.now();
    let bytesCopied = 0;
    let lastBucket = -1;

    const readStream = fs.createReadStream(sourcePath, { highWaterMark: CHUNK_SIZE });
    const writeStream = fs.createWriteStream(destPath);

    await new Promise<void>((resolve, reject) => {
      readStream.on('data', (chunk: Buffer) => {
        const chunkLen = chunk.length;
        bytesCopied += chunkLen;

        const percent = Math.min(Math.round((bytesCopied / fileSize) * 100), 100);
        void job.updateProgress(percent).catch(() => {});

        const elapsedSeconds = (Date.now() - startTime) / 1000;
        const speed = elapsedSeconds > 0 ? bytesCopied / elapsedSeconds : 0;
        const eta = speed > 0 ? (fileSize - bytesCopied) / speed : 0;

        const bucket = Math.floor(percent / 25) * 25;
        if (bucket > lastBucket && messageId != null) {
          lastBucket = bucket;
          safeUpdateAlert(
            messageId,
            alerts.progress(vodId, percent, bytesCopied, fileSize, speed, Math.round(eta)),
            log,
            vodId
          );
        }
      });

      readStream.on('error', reject);
      writeStream.on('error', reject);
      writeStream.on('finish', () => {
        resolve();
      });
      readStream.pipe(writeStream);
    });

    const elapsedSeconds = (Date.now() - startTime) / 1000;

    log.info({ sourcePath, destPath, fileSize, elapsedSeconds }, 'File copied successfully');

    if (messageId != null) {
      safeUpdateAlert(messageId, alerts.complete(vodId, destPath, fileSize, elapsedSeconds), log, vodId);
    }

    return { success: true, filePath: destPath };
  },
  {
    errorMeta,
    errorAlert: (ctx, _job, errorMsg) => {
      const alerts = createCopyWorkerAlerts();
      if (isAlertsEnabled()) {
        void initRichAlert(alerts.error(ctx.vodId, 0, 0, errorMsg)).catch(() => {});
      }
      return Promise.resolve();
    },
  }
);

export default copyFileProcessor;
