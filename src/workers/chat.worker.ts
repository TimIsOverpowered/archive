import { Processor, Job } from 'bullmq';
import { sleep } from '../utils/delay.js';
import { fetchComments, fetchNextComments, extractMessageData } from '../services/twitch';
import { initRichAlert, updateAlert, resetFailures } from '../utils/discord-alerts.js';
import type { ChatDownloadJob, ChatDownloadResult } from './jobs/queues.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { getJobContext } from './job-context.js';
import { CHAT_BATCH_SIZE, CHAT_RATE_LIMIT_MS } from '../constants.js';
import { extractEdges, calculateResumeOffset } from './chat/chat-helpers.js';
import type { ChatMessageCreateInput } from './chat/chat-types.js';
import { handleWorkerError } from './utils/error-handler.js';
import { flushChatBatch } from './chat/chat-batch-processor.js';

const chatProcessor: Processor<ChatDownloadJob, ChatDownloadResult> = async (job: Job<ChatDownloadJob>): Promise<ChatDownloadResult> => {
  const { tenantId, dbId, vodId, platform, duration, startOffset } = job.data;
  const log = createAutoLogger(tenantId);

  log.debug({ jobId: job.id, tenantId, dbId, vodId, platform, duration, startOffset }, '[Chat] Job received');

  if (platform !== 'twitch') {
    log.info({ platform }, 'Chat download deferred for non-Twitch platform');
    return { success: true, skipped: true };
  }

  const { db } = await getJobContext(tenantId);

  const { offset: effectiveOffset, hasExistingData } = await calculateResumeOffset(db, dbId, startOffset);

  log.debug({ vodId, startOffset, effectiveOffset, hasExistingData }, '[Chat] Resume check completed');

  const messageId = await initRichAlert({
    title: hasExistingData && !startOffset ? '💬 Chat Download Resumed' : '💬 Chat Download Started',
    description: hasExistingData && !startOffset ? `${tenantId} - Continuing from offset ${effectiveOffset.toFixed(2)}s` : `${tenantId} - Fetching chat messages for ${vodId}`,
    status: 'warning',
    fields: [
      { name: 'Platform', value: platform, inline: true },
      { name: 'VOD ID', value: String(vodId), inline: false },
      ...(effectiveOffset > 0
        ? [
            {
              name: startOffset ? 'Start Offset' : 'Resume Offset',
              value: `${effectiveOffset.toFixed(2)}s`,
              inline: true,
            },
          ]
        : []),
    ],
    timestamp: new Date().toISOString(),
  });

  let totalMessages = 0;
  let batchCount = 0;
  const batchBuffer: ChatMessageCreateInput[] = [];

  try {
    log.info({ vodId, effectiveOffset }, 'Starting chat download');

    // Move initial fetch OUTSIDE the loop - proper cursor-based pagination
    let rawPage = await fetchComments(String(vodId), effectiveOffset);

    log.debug({ vodId, effectiveOffset }, '[Chat] Initial comments fetch completed');

    // Cursor stagnation protection variables
    let lastCursor: string | null = null;
    let lastOffset = effectiveOffset;

    while (true) {
      if (!rawPage || typeof rawPage !== 'object') break;

      let commentsObj: Record<string, unknown>;

      if ('comments' in rawPage && typeof rawPage.comments === 'object') {
        const c = (rawPage as { comments?: object }).comments;
        commentsObj = Array.isArray(c) ? {} : ((c ?? {}) as Record<string, unknown>);
      } else {
        break; // No more data to fetch - exit gracefully
      }

      const edges = extractEdges(commentsObj);

      if (edges.length === 0) {
        log.warn({ vodId, effectiveOffset }, 'No chat messages found for VOD');

        resetFailures(tenantId);

        if (messageId) {
          void updateAlert(messageId, {
            title: '[Chat] Download Complete',
            description: `${tenantId} - No chat messages found for VOD ${vodId}`,
            status: 'warning',
            fields: [
              { name: 'Platform', value: platform, inline: true },
              { name: 'Total Messages', value: '0 (None found)', inline: false },
              {
                name: 'Note',
                value: 'Chat history may be disabled or not yet indexed. Check VOD settings.',
                inline: false,
              },
            ],
            timestamp: new Date().toISOString(),
          });
        }

        return { success: true, totalMessages: 0 };
      }

      for (const edge of edges) {
        const node = edge.node;
        if (!node || !('id' in node)) continue;

        const { message, userBadges } = extractMessageData(node);
        const offsetSeconds = 'contentOffsetSeconds' in node ? (node.contentOffsetSeconds ?? 0) : 0;

        batchBuffer.push({
          id: node.id,
          vod_id: dbId,
          display_name: ('commenter' in node && node.commenter?.displayName) || null,
          content_offset_seconds: String(offsetSeconds),
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
          tenantId,
          messageId,
          duration,
          lastOffset,
          totalMessages,
          batchCount,
        });
        totalMessages = result.totalMessages;
        batchCount = result.batchCount;
      }

      // Cursor stagnation check - prevent infinite loops without hard caps
      const pageCursor = edges[edges.length - 1]?.cursor ?? null;

      if (!pageCursor || pageCursor === lastCursor) {
        log.info({ vodId }, 'Reached end of chat stream');
        break;
      }

      lastCursor = pageCursor;

      await sleep(CHAT_RATE_LIMIT_MS);

      rawPage = await fetchNextComments(String(vodId), pageCursor); // Only used for subsequent pages now!
    }

    if (batchBuffer.length > 0) {
      const result = await flushChatBatch({
        db,
        buffer: batchBuffer,
        log,
        vodId,
        tenantId,
        messageId,
        duration,
        lastOffset,
        totalMessages,
        batchCount,
      });
      totalMessages = result.totalMessages;
      batchCount = result.batchCount;
    }

    resetFailures(tenantId);

    log.debug({ vodId, totalMessages, batchCount, finalOffset: lastOffset }, '[Chat] Download completed successfully');

    if (messageId) {
      const resumeIndicator = startOffset || hasExistingData ? ' [Resumed]' : '';

      void updateAlert(messageId, {
        title: '[Chat] Download Complete' + resumeIndicator,
        description: `${tenantId} - Successfully fetched ${totalMessages.toLocaleString()} chat messages for VOD ${vodId}`,
        status: totalMessages > 0 ? 'success' : 'warning',
        fields: [
          { name: 'Platform', value: platform, inline: true },
          {
            name: 'Total Messages Processed',
            value: String(totalMessages),
            inline: false,
          },
          {
            name: 'Total Batches',
            value: String(batchCount),
            inline: true,
          },
          ...(startOffset || hasExistingData
            ? [
                {
                  name: startOffset ? 'Resume Point' : 'Auto-Resumed From',
                  value: `${parseFloat(String(startOffset ?? 0)).toFixed(2)}s → Final offset reached`,
                  inline: false,
                },
              ]
            : []),
        ],
        timestamp: new Date().toISOString(),
        updatedTimestamp: new Date().toISOString(),
      });
    }

    return { success: true, totalMessages };
  } catch (error) {
    const errorMsg = handleWorkerError(error, log, { vodId, platform, dbId, tenantId, jobId: job.id });

    if (messageId) {
      void updateAlert(messageId, {
        title: '[Chat] Download Failed',
        description: `${tenantId} - Error fetching chat messages for VOD ${vodId}`,
        status: 'error',
        fields: [
          { name: 'Platform', value: platform, inline: true },
          { name: 'Messages Processed Before Failure', value: String(totalMessages), inline: true },
          { name: 'Error', value: errorMsg, inline: false },
        ],
        timestamp: new Date().toISOString(),
        updatedTimestamp: new Date().toISOString(),
      });
    }

    throw error;
  }
};

export default chatProcessor;
