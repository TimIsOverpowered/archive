import { Processor, Job } from 'bullmq';
import { buildVodProcessorContext, runVodDownload, sendVodCompletion } from './vod.worker.phases.js';
import { handleWorkerError } from './utils/error-handler.js';
import { updateAlert } from '../utils/discord-alerts.js';
import type { StandardVodJob } from './jobs/types.js';

const vodProcessor: Processor<StandardVodJob, unknown, string> = async (
  job: Job<StandardVodJob, unknown, string>,
) => {
  const ctx = await buildVodProcessorContext(job);

  try {
    await runVodDownload(ctx);
    await sendVodCompletion(ctx);
    return { success: true, finalPath: ctx.finalPath };
  } catch (error) {
    const errorMsg = handleWorkerError(error, ctx.log, {
      vodId: ctx.vodId,
      platform: ctx.platform,
      jobId: job.id,
      dbId: ctx.dbId,
      tenantId: ctx.tenantId,
    });
    await updateAlert(ctx.messageId, ctx.alerts.error(ctx.vodId, ctx.platform, errorMsg));
    throw error;
  }
};

export default vodProcessor;
