import { Processor, Job } from 'bullmq';
import { getClient, createClient } from '../db/client.js';
import { getTenantConfig } from '../config/loader.js';
import { extractErrorDetails } from '../utils/error.js';
import { sleep } from '../utils/delay.js';
import { fetchComments, fetchNextComments, type TwitchChatEdge } from '../services/twitch';
import { sendRichAlert, updateDiscordEmbed, formatProgressMessage, resetFailures, isAlertsEnabled } from '../utils/discord-alerts.js';
import type { ChatDownloadJob, ChatDownloadResult } from '../jobs/queues.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { parseDuration } from '../utils/formatting.js';

// Custom JSON value type compatible with Prisma's InputJsonValue without importing internal types
type JsonValue = string | number | boolean | { [key: string]: JsonValue } | JsonValue[];

interface ChatMessageCreateInput {
  id: string;
  vod_id: string;
  display_name: string | null;
  content_offset_seconds: string; // String for Decimal precision preservation
  created_at: Date | null;
  message?: JsonValue;
  user_badges?: JsonValue;
  user_color: string | null;
}

const BATCH_SIZE = 2500;
const RATE_LIMIT_MS = 150;

function formatTime(seconds: number): string {
  const { hrs, mins, secs } = parseDuration(seconds);
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toFixed(1).toString()}`;
}

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

const chatProcessor: Processor<ChatDownloadJob, ChatDownloadResult> = async (job: Job<ChatDownloadJob>): Promise<ChatDownloadResult> => {
  const { tenantId, vodId, platform, duration, startOffset } = job.data;
  const log = createAutoLogger(tenantId);

  if (platform !== 'twitch') {
    log.info(`Chat download for ${platform} is deferred`);
    return { success: true, skipped: true };
  }

  const config = getTenantConfig(tenantId);
  if (!config) throw new Error(`Stream config not found for ${tenantId}`);

  let db = getClient(tenantId);
  if (!db) db = await createClient(config);

  // Smart resume - check for existing data if no manual override provided
  const lastSavedRecord = !startOffset
    ? await db.chatMessage.findFirst({
        where: { vod_id: vodId },
        orderBy: { content_offset_seconds: 'desc' },
        select: { content_offset_seconds: true },
      })
    : null;

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
          { name: 'VOD ID', value: vodId, inline: false },
          ...(effectiveOffset > 0
            ? [
                {
                  name: startOffset ? 'Start Offset' : 'Resume Offset',
                  value: effectiveOffset.toFixed(2) + 's (' + formatTime(effectiveOffset) + ')',
                  inline: true,
                },
              ]
            : []),
        ],
        timestamp: new Date().toISOString(),
      })
    : null;

  try {
    let totalMessages = 0;
    let batchCount = 0;

    log.info('[' + vodId + '] Starting chat download' + (effectiveOffset > 0 ? ' from offset ' + effectiveOffset.toFixed(2) + 's' : ''));

    // Move initial fetch OUTSIDE the loop - proper cursor-based pagination
    let rawPage = await fetchComments(vodId, effectiveOffset);

    // Cursor stagnation protection variables
    let lastCursor: string | null = null;

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

      const messagesToInsert: ChatMessageCreateInput[] = [];

      for (const edge of edges) {
        const node = edge.node;
        if (!node || !('id' in node)) continue;

        const { message, userBadges } = extractMessageData(node);
        const offsetSeconds = 'contentOffsetSeconds' in node ? (node.contentOffsetSeconds ?? 0) : 0;

        messagesToInsert.push({
          id: node.id,
          vod_id: vodId,
          display_name: ('commenter' in node && node.commenter?.displayName) || null,
          content_offset_seconds: String(offsetSeconds), // Preserve Decimal precision
          created_at: 'createdAt' in node && node.createdAt ? new Date(node.createdAt as string) : null,
          message,
          user_badges: userBadges ?? undefined,
          user_color: ('message' in node && node.message?.userColor) || '#FFFFFF',
        });
      }

      if (messagesToInsert.length > 0) {
        await db.chatMessage.createMany({
          data: messagesToInsert, // Type-safe! JsonValue type matches Prisma requirements
          skipDuplicates: true,
        });
        totalMessages += messagesToInsert.length;
      }

      batchCount++;

      const lastOffset = edges[edges.length - 1]?.node?.contentOffsetSeconds ?? effectiveOffset;

      // Progress update every ~50 batches (every BATCH_SIZE messages)
      if (messageId && isAlertsEnabled() && batchCount * 50 >= BATCH_SIZE) {
        const percent = duration > 0 ? Math.min(Math.round((lastOffset / duration) * 100), 100) : 0;

        updateDiscordEmbed(messageId, {
          title: '💬 Downloading Chat',
          description: tenantId + (startOffset || lastSavedRecord?.content_offset_seconds ? ' - Resuming' : '') + ' chat download for ' + vodId,
          status: 'warning',
          fields: [
            { name: 'Current Time Offset', value: lastOffset.toFixed(2) + 's (' + formatTime(lastOffset) + ')', inline: true },
            {
              name: 'Progress',
              value: formatProgressMessage('Chat Download' + (startOffset || lastSavedRecord?.content_offset_seconds ? ' (Resumed)' : ''), tenantId, percent, totalMessages),
              inline: false,
            },
          ],
          timestamp: new Date().toISOString(),
          updatedTimestamp: new Date().toISOString(),
        });

        batchCount = 0;
      }

      // Cursor stagnation check - prevent infinite loops without hard caps
      const pageCursor = edges[edges.length - 1]?.cursor ?? null;

      if (!pageCursor || pageCursor === lastCursor) {
        log.info('[' + vodId + '] Reached end of chat stream (no next cursor or duplicate detected).');
        break; // Exit gracefully when no more pages available
      }

      lastCursor = pageCursor;

      await sleep(RATE_LIMIT_MS);

      rawPage = await fetchNextComments(vodId, pageCursor); // Only used for subsequent pages now!
    }

    resetFailures(tenantId);

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
    log.error({ vodId, platform, ...details }, 'Chat download failed');

    if (messageId && isAlertsEnabled()) {
      updateDiscordEmbed(messageId, {
        title: '[Chat] Download Failed',
        description: tenantId + ' - Error fetching chat messages for VOD ' + vodId,
        status: 'error',
        fields: [
          { name: 'Platform', value: platform, inline: true },
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
