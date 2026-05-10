import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { Job } from 'bullmq';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import type { AppLogger } from '../utils/logger.js';
import type { CopyFileJob, CopyFileResult } from './jobs/types.js';
import { wrapWorkerProcessor } from './utils/worker-wrapper.js';

interface CopyFileProcessorContext {
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

const copyFileProcessor = wrapWorkerProcessor<CopyFileJob, CopyFileProcessorContext, CopyFileResult>(
  buildCopyFileContext,
  async (ctx) => {
    const destDir = path.dirname(ctx.destPath);
    await fsPromises.mkdir(destDir, { recursive: true });
    await fsPromises.copyFile(ctx.sourcePath, ctx.destPath);
    ctx.log.info({ sourcePath: ctx.sourcePath, destPath: ctx.destPath }, 'File copied successfully');
    return { success: true, filePath: ctx.destPath };
  },
  { errorMeta, errorAlert: async () => {} }
);

export default copyFileProcessor;
