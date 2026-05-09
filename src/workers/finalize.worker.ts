import fsPromises from 'node:fs/promises';
import type { Job } from 'bullmq';
import type { Kysely } from 'kysely';
import { TenantConfig } from '../config/types.js';
import type { StreamerDB } from '../db/streamer-types.js';
import type { SourceType } from '../types/platforms.js';
import { SOURCE_TYPES } from '../types/platforms.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { ConfigNotConfiguredError } from '../utils/domain-errors.js';
import { extractErrorDetails } from '../utils/error.js';
import type { AppLogger } from '../utils/logger.js';
import { getLiveFilePath, getVodFilePath } from '../utils/path.js';
import type { VodFinalizeFileJob, VodFinalizeFileResult } from './jobs/types.js';
import { finalizeFile } from './utils/file-finalization.js';
import { getJobContext } from './utils/job-context.js';
import { wrapWorkerProcessor } from './utils/worker-wrapper.js';

interface FinalizeProcessorContext {
  log: AppLogger;
  tenantId: string;
  dbId: number;
  vodId: string;
  type: SourceType;
  filePath: string;
  config: TenantConfig;
  db: Kysely<StreamerDB>;
  startTime: number;
  workDir?: string | undefined;
  saveMP4: boolean;
  streamId?: string | undefined;
}

const buildFinalizeContext = async (job: Job<VodFinalizeFileJob>): Promise<FinalizeProcessorContext> => {
  const { tenantId, dbId, vodId, type, filePath } = job.data;
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
    filePath: actualFilePath,
    config,
    db,
    startTime,
    workDir: job.data.workDir,
    saveMP4: job.data.saveMP4,
    streamId: job.data.streamId,
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
    if (ctx.saveMP4) {
      await finalizeFile({
        filePath: ctx.filePath,
        destPath:
          ctx.type === SOURCE_TYPES.LIVE
            ? getLiveFilePath({ tenantId: ctx.tenantId, streamId: ctx.streamId ?? '' })
            : getVodFilePath({ tenantId: ctx.tenantId, vodId: ctx.vodId }),
        log: ctx.log,
        ...(ctx.workDir != null && { tmpDir: ctx.workDir }),
      });
    } else if (ctx.workDir != null) {
      await fsPromises.rm(ctx.workDir, { recursive: true, force: true }).catch((err) => {
        ctx.log.warn({ workDir: ctx.workDir, error: extractErrorDetails(err).message }, 'Failed to clean up tmpDir');
      });
    }

    const duration = Date.now() - ctx.startTime;
    ctx.log.info({ vodId: ctx.vodId, duration }, 'Finalization completed successfully');

    return { success: true };
  },
  { errorMeta, errorAlert: async () => {} }
);

export default finalizeProcessor;
