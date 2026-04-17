import { Processor, Job } from 'bullmq';
import { sleep } from '../utils/delay.js';
import { fetchComments, fetchNextComments } from '../services/twitch/index.js';
import { initRichAlert, resetFailures, updateAlert  } from '../utils/discord-alerts.js';
import type { ChatDownloadJob, ChatDownloadResult } from './jobs/queues.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { getJobContext } from './utils/job-context.js';
import { CHAT_BATCH_SIZE, CHAT_RATE_LIMIT_MS } from '../constants.js';
import { extractEdges, calculateResumeOffset, extractMessageData } from './chat/chat-helpers.js';
import type { ChatMessageCreateInput } from './chat/chat-types.js';
import { PLATFORMS } from '../types/platforms.js';
import { handleWorkerError } from './utils/error-handler.js';
import { flushChatBatch } from './chat/chat-batch-processor.js';
import { createChatWorkerAlerts } from './utils/alert-factories.js';

const chatProcessor: Processor<ChatDownloadJob, ChatDownloadResult> = async (job: Job<ChatDownloadJob>): Promise<ChatDownloadResult> => {
  const { tenantId, dbId, vodId, platform, duration, startOffset, forceRerun } = job.data;
  const log = createAutoLogger(tenantId);

  log.debug({ jobId: job.id, tenantId, dbId, vodId, platform, duration, startOffset, forceRerun }, '[Chat] Job received');

  if (platform !== PLATFORMS.TWITCH) {
    log.info({ platform }, 'Chat download deferred for non-Twitch platform');
    return { success: true, skipped: true };
  }

  const { db } = await getJobContext(tenantId);

  const { offset: effectiveOffset, hasExistingData, lastMessageId } = await calculateResumeOffset(db, dbId, startOffset);

  log.debug({ vodId, startOffset, effectiveOffset, hasExistingData }, '[Chat] Resume check completed');

  const chatAlerts = createChatWorkerAlerts();
  const isResume = hasExistingData && !startOffset;
  const messageId = await initRichAlert(chatAlerts.init(tenantId, vodId, platform, isResume, isResume ? effectiveOffset : undefined));

  let totalMessages = 0;
  let batchCount = 0;
  const batchBuffer: ChatMessageCreateInput[] = [];
  let lastOffset = effectiveOffset;

  try {
    log.info({ vodId, effectiveOffset }, 'Starting chat download');

    let rawPage = await fetchComments(vodId, effectiveOffset, tenantId);
    log.debug({ vodId, effectiveOffset }, '[Chat] Initial comments fetch completed');

    if (hasExistingData && !startOffset && !forceRerun) {
      if (duration !== 0 && effectiveOffset >= duration) {
        const totalMessages = await db.chatMessage.count({ where: { vod_id: dbId } });
        log.info({ vodId, effectiveOffset, duration, totalMessages }, 'Chat download already complete (offset exceeds duration)');
        resetFailures(tenantId);
        void updateAlert(messageId, chatAlerts.alreadyComplete(tenantId, vodId, platform, totalMessages, effectiveOffset));
        return { success: true, totalMessages, skipped: true };
      }

      if (lastMessageId && rawPage && rawPage.comments) {
        const edges = extractEdges(rawPage.comments);
        const lastFetchedMessageId = edges[edges.length - 1]?.node?.id;

        if (lastFetchedMessageId === lastMessageId) {
          const totalMessages = await db.chatMessage.count({ where: { vod_id: dbId } });
          log.info({ vodId, lastMessageId, totalMessages }, 'Chat download already complete');
          resetFailures(tenantId);
          void updateAlert(messageId, chatAlerts.alreadyComplete(tenantId, vodId, platform, totalMessages, effectiveOffset));
          return { success: true, totalMessages, skipped: true };
        }
      }
    }

    let lastCursor: string | null = null;

    while (true) {
      if (!rawPage || typeof rawPage !== 'object') break;

      const commentsObj = rawPage.comments;

      if (!commentsObj) throw `No Comments Object found`;

      const edges = extractEdges(commentsObj);

      if (edges.length === 0) {
        log.warn({ vodId, effectiveOffset }, 'No chat messages found for VOD');
        resetFailures(tenantId);
        void updateAlert(messageId, chatAlerts.noMessages(tenantId, vodId, platform, effectiveOffset));
        return { success: true, totalMessages: 0 };
      }

      for (const edge of edges) {
        const node = edge.node;
        if (!node) continue;

        const { message, userBadges } = extractMessageData(node);
        const offsetSeconds = 'contentOffsetSeconds' in node ? (node.contentOffsetSeconds ?? 0) : 0;

        batchBuffer.push({
          id: node.id,
          vod_id: dbId,
          display_name: ('commenter' in node && node.commenter?.displayName) || null,
          content_offset_seconds: Math.round(offsetSeconds),
          createdAt: 'createdAt' in node && node.createdAt ? new Date(node.createdAt as string) : new Date(),
          message,
          user_badges: userBadges,
          user_color: ('message' in node && node.message?.userColor) || '#FFFFFF',
        });
      }

      lastOffset = edges[edges.length - 1]?.node?.contentOffsetSeconds ?? lastOffset;

      if (batchBuffer.length >= CHAT_BATCH_SIZE) {
        const result = await flushChatBatch({
          db,
          buffer: batchBuffer,
          log,
          vodId,
          onProgress: (offset, batchNumber, messagesInBatch) => void updateAlert(messageId, chatAlerts.progress(tenantId, vodId, offset, batchNumber, messagesInBatch, totalMessages, duration)),
          lastOffset,
          totalMessages,
          batchCount,
        });
        totalMessages = result.totalMessages;
        batchCount = result.batchCount;
      }

      const pageCursor = edges[edges.length - 1]?.cursor ?? null;

      if (!pageCursor || pageCursor === lastCursor) {
        log.info({ vodId }, 'Reached end of chat stream');
        break;
      }

      lastCursor = pageCursor;
      await sleep(CHAT_RATE_LIMIT_MS);
      rawPage = await fetchNextComments(vodId, pageCursor, tenantId);
    }

    if (batchBuffer.length > 0) {
      const result = await flushChatBatch({
        db,
        buffer: batchBuffer,
        log,
        vodId,
        onProgress: (offset, batchNumber, messagesInBatch) => void updateAlert(messageId, chatAlerts.progress(tenantId, vodId, offset, batchNumber, messagesInBatch, totalMessages, duration)),
        lastOffset,
        totalMessages,
        batchCount,
      });
      totalMessages = result.totalMessages;
      batchCount = result.batchCount;
    }

    resetFailures(tenantId);
    log.debug({ vodId, totalMessages, batchCount, finalOffset: lastOffset }, '[Chat] Download completed successfully');

    const resumeIndicator = startOffset || hasExistingData;
    void updateAlert(messageId, chatAlerts.complete(tenantId, vodId, platform, totalMessages, batchCount, resumeIndicator ? (startOffset ?? 0) : undefined));

    return { success: true, totalMessages };
  } catch (error) {
    const errorMsg = handleWorkerError(error, log, { vodId, platform, dbId, tenantId, jobId: job.id });
    void updateAlert(messageId, chatAlerts.error(tenantId, vodId, platform, totalMessages, errorMsg));
    throw error;
  }
};

export default chatProcessor;
