import type { Job } from 'bullmq';
import { updateAlert } from '../utils/discord-alerts.js';
import type { StandardVodJob, StandardVodResult } from './jobs/types.js';
import { wrapWorkerProcessor } from './utils/worker-wrapper.js';
import { buildVodProcessorContext, runVodDownload, sendVodCompletion } from './vod.worker.phases.js';
import type { VodProcessorContext } from './vod.worker.phases.js';

const errorMeta = (ctx: VodProcessorContext) => ({
  vodId: ctx.vodId,
  platform: ctx.platform,
  dbId: ctx.dbId,
  tenantId: ctx.tenantId,
});

const errorAlert = async (ctx: VodProcessorContext, job: Job, errorMsg: string) => {
  await job.updateProgress(0);
  await updateAlert(ctx.messageId, ctx.alerts.error(ctx.vodId, ctx.platform, errorMsg));
};

const vodProcessor = wrapWorkerProcessor<StandardVodJob, VodProcessorContext, StandardVodResult>(
  buildVodProcessorContext,
  async (ctx) => {
    await runVodDownload(ctx);
    await sendVodCompletion(ctx);
    return { success: true, finalPath: ctx.finalPath };
  },
  { errorMeta, errorAlert }
);

export default vodProcessor;
