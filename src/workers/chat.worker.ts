import type { Job, Processor } from 'bullmq';
import { invalidateChatCache } from '../services/vod-cache.ts';
import { isKickPlatform, isTwitchPlatform } from '../types/platforms.ts';
import { createAutoLogger } from '../utils/auto-tenant-logger.ts';
import { updateAlert } from '../utils/discord-alerts.ts';
import { extractErrorDetails } from '../utils/error.ts';
import type { ChatProcessorContext } from './chat.worker.phases.ts';
import {
  buildChatProcessorContext,
  buildKickProcessorContext,
  checkChatCompletion,
  checkKickCompletion,
  downloadChatMessages,
  downloadKickChat,
  sendChatCompletionAlert,
  sendKickChatCompletionAlert,
} from './chat.worker.phases.ts';
import type { ChatDownloadJob, ChatDownloadResult } from './jobs/types.ts';
import { wrapWorkerProcessor } from './utils/worker-wrapper.ts';

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

const wrappedKickChatProcessor = wrapWorkerProcessor<ChatDownloadJob, ChatProcessorContext, ChatDownloadResult>(
  buildKickProcessorContext,
  async (ctx) => {
    if (!ctx.forceRerun && ctx.hasExistingData) {
      const skipResult = await checkKickCompletion(ctx);
      if (skipResult) return skipResult;
    }

    const result = await downloadKickChat(ctx);

    try {
      await invalidateChatCache(ctx.tenantId, ctx.dbId);
    } catch (err) {
      ctx.log.warn(
        { err: extractErrorDetails(err).message, vodId: ctx.vodId },
        'Failed to invalidate chat cache after successful download'
      );
    }

    sendKickChatCompletionAlert(ctx, result);

    return { success: true, ...result };
  },
  { errorMeta, errorAlert }
);

const chatProcessor: Processor<ChatDownloadJob, ChatDownloadResult> = async (job) => {
  const { platform } = job.data;

  if (isKickPlatform(platform)) {
    return wrappedKickChatProcessor(job);
  }

  if (!isTwitchPlatform(platform)) {
    const log = createAutoLogger(job.data.tenantId);
    log.info({ platform }, 'Chat download deferred for non-Twitch platform');
    return { success: true, skipped: true };
  }

  return wrappedChatProcessor(job);
};

export default chatProcessor;
