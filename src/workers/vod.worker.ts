import type { Job } from 'bullmq';
import { getTmpDirPath } from '../utils/path.ts';
import { updateAlert } from '../utils/discord-alerts.ts';
import type { StandardVodJob, StandardVodResult } from './jobs/types.ts';
import { wrapWorkerProcessor } from './utils/worker-wrapper.ts';
import { reapWorkDir } from './utils/workdir.ts';
import type { VodProcessorContext } from './vod.worker.phases.ts';
import { buildVodProcessorContext, runVodDownload, sendVodCompletion } from './vod.worker.phases.ts';

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
  {
    errorMeta,
    errorAlert,
    finally: async (ctx, _job, outcome) => {
      if (outcome.failed && !outcome.willRetry) {
        await reapWorkDir(getTmpDirPath({ tenantId: ctx.tenantId, vodId: ctx.vodId }), ctx.log);
      }
    },
  }
);

export default vodProcessor;
