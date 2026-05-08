import type { Job } from 'bullmq';
import { SOURCE_TYPES } from '../types/platforms.js';
import { updateAlert } from '../utils/discord-alerts.js';
import { extractErrorDetails } from '../utils/error.js';
import { getLiveFilePath, getVodFilePath } from '../utils/path.js';
import { cleanupTempFiles } from './dmca/dmca.js';
import { buildDmcaProcessorContext, trimDmcaVideo, processDmcaClaims, queueDmcaUpload } from './dmca.worker.phases.js';
import type { DmcaProcessorContext } from './dmca.worker.phases.js';
import type { DmcaProcessingJob, DmcaProcessingResult } from './jobs/types.js';
import { finalizeVodFile } from './utils/file-finalization.js';
import { wrapWorkerProcessor } from './utils/worker-wrapper.js';

const errorMeta = (ctx: DmcaProcessorContext, job: Job<unknown>) => ({
  vodId: ctx.vodId,
  dbId: ctx.dbId,
  tenantId: ctx.tenantId,
  jobId: job.id,
  platform: ctx.platform,
});

const errorAlert = async (ctx: DmcaProcessorContext, _job: Job, errorMsg: string) => {
  await updateAlert(ctx.messageId, ctx.alerts.error(ctx.vodId, errorMsg));
};

const dmcaProcessor = wrapWorkerProcessor<DmcaProcessingJob, DmcaProcessorContext, DmcaProcessingResult>(
  buildDmcaProcessorContext,
  async (ctx) => {
    if (ctx.blockingClaims.length === 0) {
      ctx.log.info({ vodId: ctx.vodId }, 'No blocking claims for VOD');
      await updateAlert(ctx.messageId, ctx.alerts.complete(ctx.vodId, 'N/A', [], ctx.platform, ctx.displayName));
      return { success: true, message: 'No action needed' };
    }

    await trimDmcaVideo(ctx);
    await processDmcaClaims(ctx);
    await queueDmcaUpload(ctx);

    return { success: true, vodId: ctx.vodId };
  },
  {
    errorMeta,
    errorAlert,
    finally: async (ctx) => {
      if (ctx.tempFiles.length > 0) {
        await cleanupTempFiles(ctx.tempFiles);
      }
      // Finalize: move original full VOD to storage or delete from tmpPath
      try {
        await finalizeVodFile({
          filePath: ctx.filePath,
          destPath:
            ctx.type === SOURCE_TYPES.LIVE
              ? getLiveFilePath({ streamId: ctx.vodId })
              : getVodFilePath({ vodId: ctx.vodId }),
          tmpDir: ctx.workDir,
          saveMP4: ctx.config.settings.saveMP4 ?? false,
          log: ctx.log,
        });
      } catch (err) {
        ctx.log.warn({ err: extractErrorDetails(err), vodId: ctx.vodId }, 'Failed to finalize DMCA processed VOD');
      }
    },
  }
);

export default dmcaProcessor;
