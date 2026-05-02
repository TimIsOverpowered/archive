import { Processor, Job } from 'bullmq';
import { buildDmcaProcessorContext, trimDmcaVideo, processDmcaClaims, queueDmcaUpload } from './dmca.worker.phases.js';
import type { DmcaProcessorContext } from './dmca.worker.phases.js';
import { handleWorkerError } from './utils/error-handler.js';
import { updateAlert } from '../utils/discord-alerts.js';
import type { DmcaProcessingJob, DmcaProcessingResult } from './jobs/types.js';
import { cleanupTempFiles } from './dmca/dmca.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';

const dmcaProcessor: Processor<DmcaProcessingJob, DmcaProcessingResult> = async (
  job: Job<DmcaProcessingJob>
): Promise<DmcaProcessingResult> => {
  let ctx: DmcaProcessorContext | undefined;

  try {
    ctx = await buildDmcaProcessorContext(job);

    if (ctx.blockingClaims.length === 0) {
      ctx.log.info({ vodId: ctx.vodId }, 'No blocking claims for VOD');
      await updateAlert(ctx.messageId, ctx.dmcaAlerts.complete(ctx.vodId, 'N/A', [], ctx.platform, ctx.displayName));
      return { success: true, message: 'No action needed' };
    }

    await trimDmcaVideo(ctx);
    await processDmcaClaims(ctx);
    await queueDmcaUpload(ctx);

    if (!ctx.config.settings.saveMP4) {
      ctx.tempFiles.push(ctx.filePath);
    }

    return { success: true, vodId: ctx.vodId };
  } catch (error) {
    const fallbackLog = createAutoLogger(job.data.tenantId);
    const errorMsg = handleWorkerError(error, ctx?.log ?? fallbackLog, {
      vodId: ctx?.vodId ?? job.data.vodId,
      dbId: ctx?.dbId ?? job.data.dbId,
      tenantId: ctx?.tenantId ?? job.data.tenantId,
      jobId: job.id,
      platform: ctx?.platform ?? job.data.platform,
    });
    if (ctx != null) {
      await updateAlert(ctx.messageId, ctx.dmcaAlerts.error(ctx.vodId, errorMsg));
    }
    throw error;
  } finally {
    if (ctx != null && ctx.tempFiles.length > 0) {
      await cleanupTempFiles(ctx.tempFiles);
    }
  }
};

export default dmcaProcessor;
