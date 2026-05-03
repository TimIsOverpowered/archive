import { Job } from 'bullmq';
import { sleep, jitter } from '../utils/delay.js';
import { fetchComments, fetchNextComments, type TwitchVideoCommentResponse } from '../services/twitch/index.js';
import { resetFailures } from '../utils/discord-alerts.js';
import type { ChatDownloadJob, ChatDownloadResult } from './jobs/types.js';
import { Chat } from '../constants.js';
import { extractEdges, calculateResumeOffset, extractMessageData } from './chat/chat-helpers.js';
import type { ChatMessageCreateInput } from './chat/chat-types.js';
import { type Platform } from '../types/platforms.js';
import { flushChatBatch } from './chat/chat-batch-processor.js';
import { createChatWorkerAlerts, safeUpdateAlert } from './utils/alert-factories.js';
import { getDisplayName, type TenantConfig } from '../config/types.js';
import type { Kysely } from 'kysely';
import type { StreamerDB } from '../db/streamer-types.js';
import type { ChatWorkerAlerts } from './utils/alert-factories.js';
import type { AppLogger } from '../utils/logger.js';
import { buildWorkerContext } from './utils/job-context.js';

/**
 * Context for chat download processing.
 * ctx.effectiveOffset is a pagination cursor — mutated during download to track the last processed offset.
 */
export interface ChatProcessorContext {
  job: Job<ChatDownloadJob>;
  config: TenantConfig;
  db: Kysely<StreamerDB>;
  tenantId: string;
  dbId: number;
  vodId: string;
  platform: Platform;
  duration: number;
  displayName: string;
  log: AppLogger;
  alerts: ChatWorkerAlerts;
  messageId: string | null;
  /** Pagination cursor — mutated during download to track last processed offset */
  effectiveOffset: number;
  hasExistingData: boolean;
  forceRerun: boolean;
}

export async function buildChatProcessorContext(job: Job<ChatDownloadJob>): Promise<ChatProcessorContext> {
  const { tenantId, dbId, vodId, platform, duration, startOffset, forceRerun } = job.data;

  return buildWorkerContext(
    job,
    tenantId,
    dbId,
    vodId,
    platform,
    async (config, db) => {
      const displayName = getDisplayName(config);
      const { offset: effectiveOffset, hasExistingData } = await calculateResumeOffset(
        db,
        dbId,
        startOffset,
        forceRerun
      );
      const isResume = hasExistingData && startOffset == null;
      return {
        extra: { job, duration, forceRerun: forceRerun ?? false, displayName, effectiveOffset, hasExistingData },
        alertInitArgs: [displayName, vodId, platform, isResume, isResume ? effectiveOffset : undefined],
      };
    },
    createChatWorkerAlerts
  );
}

export async function checkChatCompletion(ctx: ChatProcessorContext): Promise<ChatDownloadResult | null> {
  const msgCountByOffset = await isCompleteByOffset(ctx.db, ctx.dbId, ctx.effectiveOffset, ctx.duration);
  if (msgCountByOffset !== null) {
    ctx.log.info(
      { vodId: ctx.vodId, effectiveOffset: ctx.effectiveOffset, duration: ctx.duration, msgCountByOffset },
      'Chat download already complete (offset exceeds duration)'
    );
    return markChatComplete(ctx, msgCountByOffset);
  }

  const msgCountByLastMessage = await isCompleteByLastMessage(
    ctx.db,
    ctx.dbId,
    ctx.vodId,
    ctx.effectiveOffset,
    ctx.tenantId
  );
  if (msgCountByLastMessage !== null) {
    ctx.log.info({ vodId: ctx.vodId, msgCountByLastMessage }, 'Chat download already complete');
    return markChatComplete(ctx, msgCountByLastMessage);
  }

  return null;
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
  tenantId: string
): Promise<number | null> {
  const lastSavedRecord = await db
    .selectFrom('chat_messages')
    .select(['id'])
    .where('vod_id', '=', dbId)
    .orderBy('content_offset_seconds', 'desc')
    .executeTakeFirst();

  if (lastSavedRecord == null) return null;
  const lastMessageId = lastSavedRecord.id;

  const rawPage = await fetchComments(vodId, effectiveOffset, tenantId);
  if (!rawPage?.comments) return null;
  const edges = extractEdges(rawPage.comments);
  const lastFetchedMessageId = edges[edges.length - 1]?.node?.id;
  if (lastFetchedMessageId !== lastMessageId) return null;
  return await countChatMessages(db, dbId);
}

function markChatComplete(ctx: ChatProcessorContext, totalMessages: number): ChatDownloadResult {
  resetFailures(ctx.tenantId);
  safeUpdateAlert(
    ctx.messageId,
    ctx.alerts.alreadyComplete(ctx.displayName, ctx.vodId, ctx.platform, totalMessages, ctx.effectiveOffset),
    ctx.log,
    ctx.vodId
  );
  return { success: true, totalMessages, skipped: true };
}

async function countChatMessages(db: Kysely<StreamerDB>, dbId: number): Promise<number> {
  const result = await db
    .selectFrom('chat_messages')
    .select((eb) => [eb.fn.count<number>('id').as('cnt')])
    .where('vod_id', '=', dbId)
    .executeTakeFirst();
  return Number(result?.cnt ?? 0);
}

export async function downloadChatMessages(
  ctx: ChatProcessorContext
): Promise<{ totalMessages: number; batchCount: number }> {
  const { displayName, dbId, vodId, platform, duration, log, alerts, messageId, db, tenantId } = ctx;
  let totalMessages = 0;
  let batchCount = 0;
  const batchBuffer: ChatMessageCreateInput[] = [];

  log.info({ vodId, effectiveOffset: ctx.effectiveOffset }, 'Starting chat download');

  const reportProgress = (offset: number) => {
    if (duration > 0) {
      const pct = Math.min(Math.round((offset / duration) * 100), 100);
      void ctx.job.updateProgress(pct);
    }
  };

  for await (const rawPage of paginateChatComments(vodId, ctx.effectiveOffset, tenantId)) {
    const commentsObj = rawPage.comments;

    if (!commentsObj) throw new Error('No comments object found');

    const edges = extractEdges(commentsObj);

    if (edges.length === 0) {
      log.warn({ vodId, effectiveOffset: ctx.effectiveOffset }, 'No chat messages found for VOD');
      resetFailures(tenantId);
      safeUpdateAlert(messageId, alerts.noMessages(displayName, vodId, platform, ctx.effectiveOffset), log, vodId);
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

    const lastOffset = edges[edges.length - 1]?.node?.contentOffsetSeconds ?? ctx.effectiveOffset;
    ctx.effectiveOffset = lastOffset;

    if (batchBuffer.length >= Chat.BATCH_SIZE) {
      const result = await flushChatBatch({
        db,
        buffer: batchBuffer,
        log,
        vodId,
        onProgress: (offset, batchNumber, messagesInBatch) => {
          reportProgress(offset);
          safeUpdateAlert(
            messageId,
            alerts.progress(displayName, vodId, offset, batchNumber, messagesInBatch, totalMessages, duration),
            log,
            vodId
          );
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
        safeUpdateAlert(
          messageId,
          alerts.progress(displayName, vodId, offset, batchNumber, messagesInBatch, totalMessages, duration),
          log,
          vodId
        );
      },
      lastOffset: ctx.effectiveOffset,
      totalMessages,
      batchCount,
    });
    totalMessages = result.totalMessages;
    batchCount = result.batchCount;
  }

  return { totalMessages, batchCount };
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
    await sleep(jitter(Chat.RATE_LIMIT_MS));
    page = await fetchNextComments(vodId, cursor, tenantId);
  }
}

export function sendChatCompletionAlert(
  ctx: ChatProcessorContext,
  result: { totalMessages: number; batchCount: number }
): void {
  resetFailures(ctx.tenantId);
  ctx.log.debug(
    { component: 'chat-worker', vodId: ctx.vodId, ...result, finalOffset: ctx.effectiveOffset },
    'Download completed successfully'
  );

  safeUpdateAlert(
    ctx.messageId,
    ctx.alerts.complete(ctx.displayName, ctx.vodId, ctx.platform, result.totalMessages, result.batchCount),
    ctx.log,
    ctx.vodId
  );
}
