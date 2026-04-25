import { Processor, Job } from 'bullmq';
import {
  buildLiveProcessorContext,
  prepareVodDirectory,
  runDownload,
  runFinalization,
  runPostProcessing,
  sendCompletionAlert,
} from './live.worker.phases.js';
import { handleWorkerError } from './utils/error-handler.js';
import { updateAlert } from '../utils/discord-alerts.js';
import type { LiveDownloadJob } from './jobs/types.js';

const liveProcessor: Processor<LiveDownloadJob, unknown, string> = async (
  job: Job<LiveDownloadJob, unknown, string>,
) => {
  const ctx = await buildLiveProcessorContext(job);

  try {
    await prepareVodDirectory(ctx);
    const downloadResult = await runDownload(ctx);
    const actualDuration = await runFinalization(ctx, downloadResult);
    const completionData = await runPostProcessing(ctx, downloadResult, actualDuration);
    await sendCompletionAlert(ctx, completionData, actualDuration);

    return { success: true };
  } catch (error) {
    const errorMsg = handleWorkerError(error, ctx.log, {
      vodId: ctx.vodId,
      jobId: job.id,
      platform: ctx.platform,
      dbId: ctx.dbId,
      tenantId: ctx.tenantId,
    });
    await updateAlert(ctx.messageId, ctx.alerts.error(ctx.vodId, errorMsg));
    throw error;
  }
};

export default liveProcessor;
