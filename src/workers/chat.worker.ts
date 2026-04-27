import { Processor, Job } from 'bullmq';
import { sleep } from '../utils/delay.js';
import { fetchComments, fetchNextComments, type TwitchVideoCommentResponse } from '../services/twitch/index.js';
import { initRichAlert, resetFailures, updateAlert } from '../utils/discord-alerts.js';
import type { ChatDownloadJob, ChatDownloadResult } from './jobs/types.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { getJobContext } from './utils/job-context.js';
import { extractErrorDetails } from '../utils/error.js';
import { CHAT_BATCH_SIZE, CHAT_RATE_LIMIT_MS } from '../constants.js';
import { extractEdges, calculateResumeOffset, extractMessageData } from './chat/chat-helpers.js';
import type { ChatMessageCreateInput } from './chat/chat-types.js';
import { PLATFORMS, isTwitchPlatform, type Platform } from '../types/platforms.js';
import { flushChatBatch } from './chat/chat-batch-processor.js';
import { createChatWorkerAlerts } from './utils/alert-factories.js';
import { getDisplayName } from '../config/types.js';
import type { Kysely } from 'kysely';
import type { StreamerDB } from '../db/streamer-types.js';

interface ChatProcessorState {
  tenantId: string;
  displayName: string;
  dbId: number;
  vodId: string;
  // Narrowed to Twitch by isTwitchPlatform() guard above — chat download only supports Twitch.
  platform: typeof PLATFORMS.TWITCH;
  duration: number;
  log: ReturnType<typeof createAutoLogger>;
  chatAlerts: ReturnType<typeof createChatWorkerAlerts>;
  messageId: string;
  db: Kysely<StreamerDB>;
  job: Job<ChatDownloadJob>;
}

const chatProcessor: Processor<ChatDownloadJob, ChatDownloadResult> = async (
  job: Job<ChatDownloadJob>
): Promise<ChatDownloadResult> => {
  const { tenantId, dbId, vodId, platform, duration, startOffset, forceRerun } = job.data;
  const log = createAutoLogger(tenantId);

  log.debug(
    { component: 'chat-worker', jobId: job.id, tenantId, dbId, vodId, platform, duration, startOffset, forceRerun },
    'Job received'
  );

  if (!isTwitchPlatform(platform)) {
    log.info({ platform }, 'Chat download deferred for non-Twitch platform');
    return { success: true, skipped: true };
  }

  const { db, config } = await getJobContext(tenantId);
  const displayName = getDisplayName(config);
  const chatAlerts = createChatWorkerAlerts();

  const {
    offset: effectiveOffset,
    hasExistingData,
    lastMessageId,
  } = await calculateResumeOffset(db, dbId, startOffset, forceRerun);
  log.debug(
    { component: 'chat-worker', vodId, startOffset, effectiveOffset, hasExistingData },
    'Resume check completed'
  );

  const messageId = await initChatAlert(
    chatAlerts,
    displayName,
    vodId,
    platform,
    effectiveOffset,
    hasExistingData,
    startOffset
  );

  if (messageId == null) {
    log.error({ component: 'chat-worker' }, 'Failed to initialize alert');
    throw new Error('Failed to initialize chat alert');
  }

  if (hasExistingData && startOffset == null) {
    const skipResult = await checkAlreadyComplete(
      db,
      dbId,
      vodId,
      effectiveOffset,
      duration,
      lastMessageId,
      chatAlerts,
      displayName,
      messageId,
      tenantId,
      log
    );
    if (skipResult) return skipResult;
  }

  const state: ChatProcessorState = {
    tenantId,
    displayName,
    dbId,
    vodId,
    platform,
    duration,
    log,
    chatAlerts,
    messageId,
    db,
    job,
  };
  const result = await processChatDownload(state, effectiveOffset);

  resetFailures(tenantId);
  log.debug(
    { component: 'chat-worker', vodId, ...result, finalOffset: effectiveOffset },
    'Download completed successfully'
  );
  const resumeIndicator = startOffset ?? hasExistingData;
  updateAlert(
    messageId,
    chatAlerts.complete(
      displayName,
      vodId,
      platform,
      result.totalMessages,
      result.batchCount,
      resumeIndicator != null ? (startOffset ?? 0) : undefined
    )
  ).catch((err) => {
    log.warn({ err: extractErrorDetails(err), vodId }, 'Discord alert update failed (non-critical)');
  });
  return { success: true, ...result };
};

async function initChatAlert(
  chatAlerts: ReturnType<typeof createChatWorkerAlerts>,
  displayName: string,
  vodId: string,
  platform: string,
  effectiveOffset: number,
  hasExistingData: boolean,
  startOffset: number | undefined
): Promise<string | null> {
  const isResume = hasExistingData && startOffset == null;
  const alertData = chatAlerts.init(
    displayName,
    vodId,
    platform as Platform,
    isResume,
    isResume ? effectiveOffset : undefined
  );
  return await initRichAlert(alertData);
}

async function countChatMessages(db: Kysely<StreamerDB>, dbId: number): Promise<number> {
  const result = await db
    .selectFrom('chat_messages')
    .select((eb) => [eb.fn.count<number>('id').as('cnt')])
    .where('vod_id', '=', dbId)
    .executeTakeFirst();
  return Number(result?.cnt ?? 0);
}

async function isCompleteByOffset(
  db: Kysely<StreamerDB>,
  dbId: number,
  effectiveOffset: number,
  duration: number
): Promise<number | null> {
  if (duration !== 0 && effectiveOffset >= duration) {
    return await countChatMessages(db, dbId);
  }
  return null;
}

async function isCompleteByLastMessage(
  db: Kysely<StreamerDB>,
  dbId: number,
  vodId: string,
  effectiveOffset: number,
  lastMessageId: string | undefined,
  tenantId: string
): Promise<number | null> {
  if (lastMessageId == null) return null;
  const rawPage = await fetchComments(vodId, effectiveOffset, tenantId);
  if (!rawPage?.comments) return null;
  const edges = extractEdges(rawPage.comments);
  const lastFetchedMessageId = edges[edges.length - 1]?.node?.id;
  if (lastFetchedMessageId !== lastMessageId) return null;
  return await countChatMessages(db, dbId);
}

function markComplete(
  displayName: string,
  vodId: string,
  messageId: string,
  chatAlerts: ReturnType<typeof createChatWorkerAlerts>,
  totalMessages: number,
  effectiveOffset: number,
  log: ReturnType<typeof createAutoLogger>
): ChatDownloadResult {
  resetFailures(displayName);
  updateAlert(
    messageId,
    chatAlerts.alreadyComplete(displayName, vodId, PLATFORMS.TWITCH, totalMessages, effectiveOffset)
  ).catch((err) => {
    log.warn({ err: extractErrorDetails(err), vodId }, 'Discord alert update failed (non-critical)');
  });
  return { success: true, totalMessages, skipped: true };
}

async function checkAlreadyComplete(
  db: Kysely<StreamerDB>,
  dbId: number,
  vodId: string,
  effectiveOffset: number,
  duration: number,
  lastMessageId: string | undefined,
  chatAlerts: ReturnType<typeof createChatWorkerAlerts>,
  displayName: string,
  messageId: string,
  tenantId: string,
  log: ReturnType<typeof createAutoLogger>
): Promise<ChatDownloadResult | null> {
  const msgCountByOffset = await isCompleteByOffset(db, dbId, effectiveOffset, duration);
  if (msgCountByOffset !== null) {
    log.info(
      { vodId, effectiveOffset, duration, msgCountByOffset },
      'Chat download already complete (offset exceeds duration)'
    );
    return markComplete(displayName, vodId, messageId, chatAlerts, msgCountByOffset, effectiveOffset, log);
  }

  const msgCountByLastMessage = await isCompleteByLastMessage(
    db,
    dbId,
    vodId,
    effectiveOffset,
    lastMessageId,
    tenantId
  );
  if (msgCountByLastMessage !== null) {
    log.info({ vodId, lastMessageId, msgCountByLastMessage }, 'Chat download already complete');
    return markComplete(displayName, vodId, messageId, chatAlerts, msgCountByLastMessage, effectiveOffset, log);
  }

  return null;
}

async function* paginateChatComments(
  vodId: string,
  offset: number,
  tenantId: string
): AsyncGenerator<TwitchVideoCommentResponse> {
  let page = await fetchComments(vodId, offset, tenantId);
  let lastCursor: string | null = null;

  while (page && typeof page === 'object') {
    yield page;
    const comments = page.comments;
    if (!comments) break;
    const edges = extractEdges(comments);
    const cursor = edges.at(-1)?.cursor ?? null;
    if (cursor == null || cursor === lastCursor) break;
    lastCursor = cursor;
    await sleep(CHAT_RATE_LIMIT_MS);
    page = await fetchNextComments(vodId, cursor, tenantId);
  }
}

async function processChatDownload(
  state: ChatProcessorState,
  effectiveOffset: number
): Promise<{ totalMessages: number; batchCount: number }> {
  const { displayName, dbId, vodId, platform, duration, log, chatAlerts, messageId, db, tenantId } = state;
  let totalMessages = 0;
  let batchCount = 0;
  const batchBuffer: ChatMessageCreateInput[] = [];
  let lastOffset = effectiveOffset;

  log.info({ vodId, effectiveOffset }, 'Starting chat download');
  const reportProgress = (offset: number) => {
    if (duration > 0) {
      const pct = Math.min(Math.round((offset / duration) * 100), 100);
      void state.job.updateProgress(pct);
    }
  };

  for await (const rawPage of paginateChatComments(vodId, effectiveOffset, tenantId)) {
    const commentsObj = rawPage.comments;

    if (!commentsObj) throw new Error('No comments object found');

    const edges = extractEdges(commentsObj);

    if (edges.length === 0) {
      log.warn({ vodId, effectiveOffset }, 'No chat messages found for VOD');
      resetFailures(tenantId);
      updateAlert(messageId, chatAlerts.noMessages(displayName, vodId, platform, effectiveOffset)).catch((err) => {
        log.warn({ err: extractErrorDetails(err), vodId }, 'Discord alert update failed (non-critical)');
      });
      return { totalMessages: 0, batchCount: 0 };
    }

    for (const edge of edges) {
      const node = edge.node;
      if (!node) continue;

      const { message, userBadges } = extractMessageData(node);
      const offsetSeconds = 'contentOffsetSeconds' in node ? (node.contentOffsetSeconds ?? 0) : 0;

      batchBuffer.push({
        id: node.id,
        vod_id: dbId,
        display_name: 'commenter' in node ? (node.commenter?.displayName ?? null) : null,
        content_offset_seconds: Math.round(offsetSeconds),
        createdAt: 'createdAt' in node && node.createdAt != null ? new Date(node.createdAt) : new Date(),
        message,
        user_badges: userBadges,
        user_color: 'message' in node ? (node.message?.userColor ?? '#FFFFFF') : '#FFFFFF',
      });
    }

    lastOffset = edges[edges.length - 1]?.node?.contentOffsetSeconds ?? lastOffset;

    if (batchBuffer.length >= CHAT_BATCH_SIZE) {
      const result = await flushChatBatch({
        db,
        buffer: batchBuffer,
        log,
        vodId,
        onProgress: (offset, batchNumber, messagesInBatch) => {
          reportProgress(offset);
          updateAlert(
            messageId,
            chatAlerts.progress(displayName, vodId, offset, batchNumber, messagesInBatch, totalMessages, duration)
          ).catch((err) => {
            log.warn({ err: extractErrorDetails(err), vodId }, 'Discord alert update failed (non-critical)');
          });
        },
        lastOffset,
        totalMessages,
        batchCount,
      });
      totalMessages = result.totalMessages;
      batchCount = result.batchCount;
    }
  }

  log.info({ vodId }, 'Reached end of chat stream');

  if (batchBuffer.length > 0) {
    const result = await flushChatBatch({
      db,
      buffer: batchBuffer,
      log,
      vodId,
      onProgress: (offset, batchNumber, messagesInBatch) => {
        reportProgress(offset);
        updateAlert(
          messageId,
          chatAlerts.progress(displayName, vodId, offset, batchNumber, messagesInBatch, totalMessages, duration)
        ).catch((err) => {
          log.warn({ err: extractErrorDetails(err), vodId }, 'Discord alert update failed (non-critical)');
        });
      },
      lastOffset,
      totalMessages,
      batchCount,
    });
    totalMessages = result.totalMessages;
    batchCount = result.batchCount;
  }

  return { totalMessages, batchCount };
}

export default chatProcessor;
