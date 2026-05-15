import type { Job, Processor } from 'bullmq';
import { invalidateChatCache } from '../services/vod-cache.js';
import { isTwitchPlatform } from '../types/platforms.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { updateAlert } from '../utils/discord-alerts.js';
import { extractErrorDetails } from '../utils/error.js';
import {
  buildChatProcessorContext,
  checkChatCompletion,
  downloadChatMessages,
  sendChatCompletionAlert,
} from './chat.worker.phases.js';
import type { ChatProcessorContext } from './chat.worker.phases.js';
import type { ChatDownloadJob, ChatDownloadResult } from './jobs/types.js';
import { wrapWorkerProcessor } from './utils/worker-wrapper.js';

const errorMeta = (ctx: ChatProcessorContext) => ({
  vodId: ctx.vodId,
  platform: ctx.platform,
  dbId: ctx.dbId,
  tenantId: ctx.tenantId,
});

const errorAlert = async (ctx: ChatProcessorContext, job: Job, errorMsg: string) => {
  await job.updateProgress(0);
  await updateAlert(ctx.messageId, ctx.alerts.error(ctx.displayName, ctx.vodId, ctx.platform, 0, errorMsg));
};

const wrappedChatProcessor = wrapWorkerProcessor<ChatDownloadJob, ChatProcessorContext, ChatDownloadResult>(
  buildChatProcessorContext,
  async (ctx) => {
    if (!ctx.forceRerun && ctx.hasExistingData) {
      const skipResult = await checkChatCompletion(ctx);
      if (skipResult) return skipResult;
    }

    const result = await downloadChatMessages(ctx);

    // Purge any partial buckets users may have permanently cached during the download phase
    try {
      await invalidateChatCache(ctx.tenantId, ctx.dbId);
    } catch (err) {
      ctx.log.warn(
        { err: extractErrorDetails(err).message, vodId: ctx.vodId },
        'Failed to invalidate chat cache after successful download'
      );
    }

    sendChatCompletionAlert(ctx, result);

    return { success: true, ...result };
  },
  { errorMeta, errorAlert }
);

const chatProcessor: Processor<ChatDownloadJob, ChatDownloadResult> = async (job) => {
  const { platform } = job.data;

  if (!isTwitchPlatform(platform)) {
    const log = createAutoLogger(job.data.tenantId);
    log.info({ platform }, 'Chat download deferred for non-Twitch platform');
    return { success: true, skipped: true };
  }

  return wrappedChatProcessor(job);
};

export default chatProcessor;
