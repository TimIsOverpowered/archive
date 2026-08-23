import type { Job } from 'bullmq';
import { updateAlert } from '../utils/discord-alerts.ts';
import { cleanupTempFiles } from './dmca/dmca.ts';
import type { DmcaProcessorContext } from './dmca.worker.phases.ts';
import { buildDmcaProcessorContext, processDmcaClaims, queueDmcaUpload, trimDmcaVideo } from './dmca.worker.phases.ts';
import type { DmcaProcessingJob, DmcaProcessingResult } from './jobs/types.ts';
import { safeUpdateAlert } from './utils/alert-factories.ts';
import { wrapWorkerProcessor } from './utils/worker-wrapper.ts';

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
      safeUpdateAlert(
        ctx.messageId,
        ctx.alerts.complete(ctx.vodId, 'N/A', [], ctx.platform, ctx.displayName),
        ctx.log,
        ctx.vodId
      );
      return { success: true, message: 'No action needed' };
    }

    await trimDmcaVideo(ctx);
    await processDmcaClaims(ctx);
    await queueDmcaUpload(ctx);

    safeUpdateAlert(
      ctx.messageId,
      ctx.alerts.complete(ctx.vodId, 'N/A', ctx.claimInfos, ctx.platform, ctx.displayName),
      ctx.log,
      ctx.vodId
    );

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
