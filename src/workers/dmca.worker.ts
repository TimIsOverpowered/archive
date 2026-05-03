import type { Job } from 'bullmq';
import { buildDmcaProcessorContext, trimDmcaVideo, processDmcaClaims, queueDmcaUpload } from './dmca.worker.phases.js';
import type { DmcaProcessorContext } from './dmca.worker.phases.js';
import { wrapWorkerProcessor } from './utils/worker-wrapper.js';
import type { DmcaProcessingJob, DmcaProcessingResult } from './jobs/types.js';
import { cleanupTempFiles } from './dmca/dmca.js';
import { updateAlert } from '../utils/discord-alerts.js';

const errorMeta = (ctx: DmcaProcessorContext, _job: Job<unknown>) => ({
  vodId: ctx.vodId,
  dbId: ctx.dbId,
  tenantId: ctx.tenantId,
  jobId: _job.id,
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

    if (!ctx.config.settings.saveMP4) {
      ctx.tempFiles.push(ctx.filePath);
    }

    return { success: true, vodId: ctx.vodId };
  },
  {
    errorMeta,
    errorAlert,
    finally: async (ctx) => {
      if (ctx.tempFiles.length > 0) {
        await cleanupTempFiles(ctx.tempFiles);
      }
    },
  }
);

export default dmcaProcessor;
