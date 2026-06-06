import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { Job } from 'bullmq';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { initRichAlert, isAlertsEnabled } from '../utils/discord-alerts.js';
import type { AppLogger } from '../utils/logger.js';
import type { CopyFileJob, CopyFileResult } from './jobs/types.js';
import { createCopyWorkerAlerts, safeUpdateAlert } from './utils/alert-factories.js';
import { convertHlsToMp4, detectFmp4FromPlaylist } from './utils/ffmpeg.js';
import { wrapWorkerProcessor } from './utils/worker-wrapper.js';

interface CopyFileProcessorContext {
  job: Job<CopyFileJob>;
  log: AppLogger;
  tenantId: string;
  dbId: number;
  vodId: string;
  sourcePath: string;
  destPath: string;
  isHlsCopy?: boolean;
}

const buildCopyFileContext = async (job: Job<CopyFileJob>): Promise<CopyFileProcessorContext> => {
  const { tenantId, dbId, vodId, sourcePath, destPath, isHlsCopy } = job.data;
  return Promise.resolve({
    job,
    log: createAutoLogger(String(tenantId)),
    tenantId,
    dbId,
    vodId,
    sourcePath,
    destPath,
    isHlsCopy: isHlsCopy ?? false,
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
    const { isHlsCopy } = ctx;

    if (isHlsCopy === true) {
      return await copyHlsDirectory(ctx);
    }

    return await copySingleFile(ctx);
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

async function copySingleFile(ctx: CopyFileProcessorContext): Promise<CopyFileResult> {
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
}

async function copyHlsDirectory(ctx: CopyFileProcessorContext): Promise<CopyFileResult> {
  const { job, log, vodId, sourcePath, destPath } = ctx;
  const alerts = createCopyWorkerAlerts();

  let messageId: string | null = null;
  if (isAlertsEnabled()) {
    messageId = await initRichAlert(alerts.init(vodId, sourcePath, destPath, 0));
  }

  await fsPromises.mkdir(destPath, { recursive: true });

  const startTime = Date.now();
  const totalSize = await getDirSize(sourcePath);
  let bytesCopied = 0;
  let lastBucket = -1;

  await fsPromises.cp(sourcePath, destPath, { recursive: true, force: true });

  const entries = await fsPromises.readdir(sourcePath);
  for (const entry of entries) {
    const stat = await fsPromises.stat(path.join(sourcePath, entry));
    bytesCopied += stat.size;
    const percent = Math.min(Math.round((bytesCopied / totalSize) * 100), 100);
    void job.updateProgress(percent).catch(() => {});

    const bucket = Math.floor(percent / 25) * 25;
    if (bucket > lastBucket && messageId != null) {
      lastBucket = bucket;
      safeUpdateAlert(messageId, alerts.progress(vodId, percent, bytesCopied, totalSize, 0, 0), log, vodId);
    }
  }

  log.info({ sourcePath, destPath, totalSize }, 'HLS directory copied to tmp path');

  // Convert HLS to MP4 in-place on local SSD
  const m3u8Path = path.join(destPath, `${vodId}.m3u8`);
  const mp4Path = path.join(destPath, `${vodId}.mp4`);

  const m3u8Content = await fsPromises.readFile(m3u8Path, 'utf8');
  const isFmp4 = detectFmp4FromPlaylist(m3u8Content);

  log.info({ vodId, isFmp4 }, 'Converting HLS segments to MP4 on local SSD');

  let ffmpegCmd: string | undefined;
  await convertHlsToMp4(m3u8Path, mp4Path, {
    vodId,
    isFmp4,
    onStart: (cmd) => {
      ffmpegCmd = cmd;
    },
    onProgress: (percent) => {
      const cmd = ffmpegCmd;
      void job.updateProgress(percent).catch(() => {});
      if (messageId != null) {
        safeUpdateAlert(messageId, alerts.converting(vodId, percent, cmd), log, vodId);
      }
    },
  });

  const elapsedSeconds = (Date.now() - startTime) / 1000;
  log.info({ vodId, mp4Path, elapsedSeconds }, 'HLS copy and conversion completed');

  if (messageId != null) {
    const stat = await fsPromises.stat(mp4Path);
    safeUpdateAlert(messageId, alerts.complete(vodId, mp4Path, stat.size, elapsedSeconds), log, vodId);
  }

  return { success: true, filePath: mp4Path };
}

async function getDirSize(dir: string): Promise<number> {
  let size = 0;
  const entries = await fsPromises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      size += await getDirSize(fullPath);
    } else {
      try {
        const stat = await fsPromises.stat(fullPath);
        size += stat.size;
      } catch {
        /* ignore */
      }
    }
  }
  return size;
}

export default copyFileProcessor;
