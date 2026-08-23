import type { Job } from 'bullmq';
import { updateAlert } from '../utils/discord-alerts.ts';
import type { LiveDownloadJob, LiveDownloadResult } from './jobs/types.ts';
import type { LiveProcessorContext } from './live.worker.phases.ts';
import {
  buildLiveProcessorContext,
  prepareVodDirectory,
  runDownload,
  runFinalization,
  runPostProcessing,
  sendCompletionAlert,
} from './live.worker.phases.ts';
import { wrapWorkerProcessor } from './utils/worker-wrapper.ts';

const errorMeta = (ctx: LiveProcessorContext) => ({
  vodId: ctx.vodId,
  platform: ctx.platform,
  dbId: ctx.dbId,
  tenantId: ctx.tenantId,
});

const errorAlert = async (ctx: LiveProcessorContext, job: Job, errorMsg: string) => {
  await job.updateProgress(0);
  await updateAlert(ctx.messageId, ctx.alerts.error(ctx.vodId, errorMsg));
};

const liveProcessor = wrapWorkerProcessor<LiveDownloadJob, LiveProcessorContext, LiveDownloadResult>(
  buildLiveProcessorContext,
  async (ctx) => {
    await prepareVodDirectory(ctx);
    const downloadResult = await runDownload(ctx);
    const actualDuration = await runFinalization(ctx, downloadResult);
    const completionData = await runPostProcessing(ctx, downloadResult, actualDuration);
    await sendCompletionAlert(ctx, completionData, actualDuration);
    return { success: true };
  },
  { errorMeta, errorAlert }
);

export default liveProcessor;
