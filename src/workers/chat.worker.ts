import { Processor, Job } from 'bullmq';
import {
  buildChatProcessorContext,
  checkChatCompletion,
  downloadChatMessages,
  sendChatCompletionAlert,
} from './chat.worker.phases.js';
import { handleWorkerError } from './utils/error-handler.js';
import { updateAlert } from '../utils/discord-alerts.js';
import type { ChatDownloadJob, ChatDownloadResult } from './jobs/types.js';
import { isTwitchPlatform } from '../types/platforms.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';

const chatProcessor: Processor<ChatDownloadJob, ChatDownloadResult> = async (
  job: Job<ChatDownloadJob>
): Promise<ChatDownloadResult> => {
  const { platform } = job.data;

  if (!isTwitchPlatform(platform)) {
    const log = createAutoLogger(job.data.tenantId);
    log.info({ platform }, 'Chat download deferred for non-Twitch platform');
    return { success: true, skipped: true };
  }

  const ctx = await buildChatProcessorContext(job);

  try {
    if (!ctx.forceRerun && ctx.hasExistingData) {
      const skipResult = await checkChatCompletion(ctx);
      if (skipResult) return skipResult;
    }

    const result = await downloadChatMessages(ctx);
    sendChatCompletionAlert(ctx, result);

    return { success: true, ...result };
  } catch (error) {
    const errorMsg = handleWorkerError(error, ctx.log, {
      vodId: ctx.vodId,
      jobId: job.id,
      platform: ctx.platform,
      dbId: ctx.dbId,
      tenantId: ctx.tenantId,
    });
    await updateAlert(ctx.messageId, ctx.chatAlerts.error(ctx.displayName, ctx.vodId, ctx.platform, 0, errorMsg));
    throw error;
  }
};

export default chatProcessor;
