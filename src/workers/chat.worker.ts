import { Processor, Job } from 'bullmq';
import { extractErrorDetails } from '../utils/error.js';
import { sleep } from '../utils/delay.js';
import { fetchComments, fetchNextComments, type TwitchChatEdge } from '../services/twitch';
import { sendRichAlert, updateDiscordEmbed, formatProgressMessage, resetFailures, isAlertsEnabled } from '../utils/discord-alerts.js';
import type { ChatDownloadJob, ChatDownloadResult } from './jobs/queues.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { getJobContext } from './job-context.js';

// Custom JSON value type compatible with Prisma's InputJsonValue without importing internal types
type JsonValue = string | number | boolean | { [key: string]: JsonValue } | JsonValue[];

interface ChatMessageCreateInput {
  id: string;
  vod_id: number;
  display_name: string | null;
  content_offset_seconds: string; // String for Decimal precision preservation
  createdAt: Date;
  message?: JsonValue;
  user_badges?: JsonValue;
  user_color: string | null;
}

const BATCH_SIZE = 2500;
const RATE_LIMIT_MS = 150;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

function stripTypename(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => stripTypename(item));
  }
  if (typeof obj === 'object') {
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key !== '__typename') {
        cleaned[key] = stripTypename(value);
      }
    }
    return cleaned;
  }
  return obj;
}

function extractMessageData(node: TwitchChatEdge['node']): { message: JsonValue; userBadges?: JsonValue | undefined } {
  if (!node || !node.message) {
    return { message: { content: '', fragments: [] }, userBadges: undefined };
  }

  const rawFragments = node.message.fragments || [];
  const cleanFragments = stripTypename(rawFragments);
  const badgesRaw = node.message.userBadges ?? null;

  return {
    message: {
      content: (Array.isArray(cleanFragments) ? cleanFragments : [])
        .map((f: unknown) => {
          if (typeof f !== 'object' || f === null) return '';
          const text = (f as Record<string, unknown>).text;
          return String(text ?? '');
        })
        .join(''),
      fragments: Array.isArray(cleanFragments) ? cleanFragments.map((frag) => ({ ...frag })) : [],
    },
    userBadges: badgesRaw && typeof stripTypename(badgesRaw) === 'object' ? (stripTypename(badgesRaw) as JsonValue) : undefined,
  };
}

function extractEdges(commentsObj: Record<string, unknown>): TwitchChatEdge[] {
  const rawEdges = commentsObj.edges;

  if (!Array.isArray(rawEdges)) {
    return [];
  }

  // Type guard proves to TypeScript that these are valid edges at runtime
  return rawEdges.filter((item): item is TwitchChatEdge => item !== null && typeof item === 'object' && 'node' in item && 'cursor' in item);
}

async function flushBatch(
  db: any,
  buffer: ChatMessageCreateInput[],
  log: any,
  vodId: string,
  tenantId: string,
  messageId: string | null,
  duration: number,
  lastOffset: number,
  totalMessagesRef: { value: number },
  batchCountRef: { value: number }
): Promise<void> {
  if (buffer.length === 0) return;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await db.chatMessage.createMany({
        data: buffer,
        skipDuplicates: true,
      });

      totalMessagesRef.value += buffer.length;
      batchCountRef.value++;

      log.debug(
        {
          vodId,
          batchNumber: batchCountRef.value,
          messagesInBatch: buffer.length,
          totalMessages: totalMessagesRef.value,
        },
        '[Chat] Batch flushed to database'
      );

      if (messageId && isAlertsEnabled()) {
        const percent = duration > 0 ? Math.min(Math.round((lastOffset / duration) * 100), 100) : 0;

        updateDiscordEmbed(messageId, {
          title: '💬 Downloading Chat',
          description: tenantId + ' chat download for ' + vodId,
          status: 'warning',
          fields: [
            { name: 'Current Offset', value: lastOffset.toFixed(2) + 's', inline: true },
            { name: 'Batch', value: '#' + batchCountRef.value + ' (' + buffer.length + ' messages)', inline: true },
            {
              name: 'Progress',
              value: formatProgressMessage('Chat Download', tenantId, percent, totalMessagesRef.value),
              inline: false,
            },
          ],
          timestamp: new Date().toISOString(),
          updatedTimestamp: new Date().toISOString(),
        });
      }

      buffer.length = 0;
      return;
    } catch (error) {
      lastError = error as Error;
      log.warn(
        {
          vodId,
          attempt,
          maxRetries: MAX_RETRIES,
          bufferLength: buffer.length,
          error: extractErrorDetails(error).message,
        },
        '[Chat] Batch flush failed, retrying...'
      );

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  log.error({ vodId, bufferLength: buffer.length }, '[Chat] Batch flush failed after all retries');
  throw lastError;
}

const chatProcessor: Processor<ChatDownloadJob, ChatDownloadResult> = async (job: Job<ChatDownloadJob>): Promise<ChatDownloadResult> => {
  const { tenantId, dbId, vodId, platform, duration, startOffset } = job.data;
  const log = createAutoLogger(tenantId);

  log.debug({ jobId: job.id, tenantId, dbId, vodId, platform, duration, startOffset }, '[Chat] Job received');

  if (platform !== 'twitch') {
    log.info(`Chat download for ${platform} is deferred`);
    return { success: true, skipped: true };
  }

  const { db } = await getJobContext(tenantId);

  // Smart resume - check for existing data if no manual override provided
  const lastSavedRecord = !startOffset
    ? await db.chatMessage.findFirst({
        where: { vod_id: dbId },
        orderBy: { content_offset_seconds: 'desc' },
        select: { content_offset_seconds: true },
      })
    : null;

  log.debug({ vodId, startOffset, hasExistingData: !!lastSavedRecord, lastOffset: lastSavedRecord?.content_offset_seconds }, '[Chat] Resume check completed');

  let effectiveOffset = startOffset || 0;

  if (lastSavedRecord?.content_offset_seconds) {
    effectiveOffset = parseFloat(lastSavedRecord.content_offset_seconds.toString());
    log.info('[' + vodId + '] Found existing chat data, resuming from offset ' + effectiveOffset.toFixed(2) + 's');
  }

  const messageId = isAlertsEnabled()
    ? await sendRichAlert({
        title: lastSavedRecord?.content_offset_seconds && !startOffset ? `💬 Chat Download Resumed` : `💬 Chat Download Started`,
        description: `${tenantId} - ${lastSavedRecord?.content_offset_seconds && !startOffset ? 'Continuing from offset ' + effectiveOffset.toFixed(2) + 's' : 'Fetching chat messages'} for ${vodId}`,
        status: 'warning',
        fields: [
          { name: 'Platform', value: platform, inline: true },
          { name: 'VOD ID', value: String(vodId), inline: false },
          ...(effectiveOffset > 0
            ? [
                {
                  name: startOffset ? 'Start Offset' : 'Resume Offset',
                  value: effectiveOffset.toFixed(2) + 's',
                  inline: true,
                },
              ]
            : []),
        ],
        timestamp: new Date().toISOString(),
      })
    : null;

  let totalMessages = 0;
  let batchCount = 0;
  const batchBuffer: ChatMessageCreateInput[] = [];

  try {
    log.info('[' + vodId + '] Starting chat download' + (effectiveOffset > 0 ? ' from offset ' + effectiveOffset.toFixed(2) + 's' : ''));

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

      if (edges.length === 0) continue; // Type-safe access to .length property

      // Empty first page scenario - treat as success with warning, not failure
      if (!edges || edges.length === 0) {
        log.warn('[' + vodId + '] No chat messages found for this VOD (or at current offset ' + effectiveOffset.toFixed(2) + 's). This may be due to disabled chat history or indexing delay.');

        resetFailures(tenantId);

        if (messageId && isAlertsEnabled()) {
          updateDiscordEmbed(messageId, {
            title: '[Chat] Download Complete',
            description: tenantId + ' - No chat messages found for VOD ' + vodId,
            status: 'warning', // Use warning instead of success to alert admins
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

        return { success: true, totalMessages: 0 }; // Success with zero count
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

      if (batchBuffer.length >= BATCH_SIZE) {
        await flushBatch(db, batchBuffer, log, vodId, tenantId, messageId, duration, lastOffset, { value: totalMessages }, { value: batchCount });
      }

      // Cursor stagnation check - prevent infinite loops without hard caps
      const pageCursor = edges[edges.length - 1]?.cursor ?? null;

      if (!pageCursor || pageCursor === lastCursor) {
        log.info('[' + vodId + '] Reached end of chat stream (no next cursor or duplicate detected).');
        break; // Exit gracefully when no more pages available
      }

      lastCursor = pageCursor;

      await sleep(RATE_LIMIT_MS);

      rawPage = await fetchNextComments(String(vodId), pageCursor); // Only used for subsequent pages now!
    }

    if (batchBuffer.length > 0) {
      await flushBatch(db, batchBuffer, log, vodId, tenantId, messageId, duration, lastOffset, { value: totalMessages }, { value: batchCount });
    }

    resetFailures(tenantId);

    log.debug({ vodId, totalMessages, batchCount, finalOffset: lastOffset }, '[Chat] Download completed successfully');

    if (messageId && isAlertsEnabled()) {
      const resumeIndicator = startOffset || lastSavedRecord?.content_offset_seconds ? ' [Resumed]' : '';

      updateDiscordEmbed(messageId, {
        title: '[Chat] Download Complete' + resumeIndicator,
        description: tenantId + ' - Successfully fetched ' + totalMessages.toLocaleString() + ' chat messages for VOD ' + vodId,
        status: totalMessages > 0 ? 'success' : 'warning', // Warning if zero messages found
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
          ...(startOffset || lastSavedRecord?.content_offset_seconds
            ? [
                {
                  name: startOffset ? 'Resume Point' : 'Auto-Resumed From',
                  value: parseFloat(String(startOffset ?? 0)).toFixed(2) + 's → Final offset reached',
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
    const details = extractErrorDetails(error);
    log.error({ vodId, platform, totalMessages, batchCount, ...details }, 'Chat download failed');

    if (messageId && isAlertsEnabled()) {
      updateDiscordEmbed(messageId, {
        title: '[Chat] Download Failed',
        description: tenantId + ' - Error fetching chat messages for VOD ' + vodId,
        status: 'error',
        fields: [
          { name: 'Platform', value: platform, inline: true },
          { name: 'Messages Processed Before Failure', value: String(totalMessages), inline: true },
          { name: 'Error', value: details.message.substring(0, 500), inline: false },
        ],
        timestamp: new Date().toISOString(),
        updatedTimestamp: new Date().toISOString(),
      });
    }

    throw error;
  }
};

export default chatProcessor;
