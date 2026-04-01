import { Processor, Job } from 'bullmq';
import { getClient, createClient } from '../db/client.js';
import { getStreamerConfig } from '../config/loader.js';
import { extractErrorDetails } from '../utils/error.js';
import { fetchComments, fetchNextComments } from '../services/twitch';
import { sendRichAlert, updateDiscordEmbed, formatProgressMessage, resetFailures, isAlertsEnabled } from '../utils/alerts';
import { ChatDownloadJob } from '../jobs/queues';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';

const BATCH_SIZE = 2500;
const RATE_LIMIT_MS = 150;

function stripTypename(obj: any): any {
  if (obj === null || obj === undefined) return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => stripTypename(item));
  }

  if (typeof obj === 'object') {
    const cleaned: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key !== '__typename') {
        cleaned[key] = stripTypename(value);
      }
    }
    return cleaned;
  }

  return obj;
}

function extractMessageData(node: any): { message: Record<string, any>; userBadges: Record<string, any> } {
  const fragments = node.message?.fragments || [];
  const cleanFragments = stripTypename(fragments);
  const badges = node.user_badges || [];

  return {
    message: {
      content: (cleanFragments as Array<{ text?: string }> | undefined)?.map((f: any) => f.text).join('') || '',
      fragments: cleanFragments,
    },
    userBadges: stripTypename(badges),
  };
}

const chatProcessor: Processor<ChatDownloadJob> = async (job: Job<ChatDownloadJob>) => {
  const { streamerId, vodId, platform, duration, startOffset } = job.data;

  // Create logger with tenant context ONCE at start of processing scope
  const log = createAutoLogger(String(streamerId));

  if (platform !== 'twitch') {
    log.info(`Chat download for ${platform} is deferred`);
    return { success: true, skipped: true };
  }

  const config = getStreamerConfig(streamerId);
  if (!config) {
    throw new Error(`Stream config not found for ${streamerId}`);
  }

  let db = getClient(streamerId);
  if (!db) {
    db = await createClient(config);
  }

  const messageId = isAlertsEnabled()
    ? await sendRichAlert({
        title: `💬 Chat Download Started`,
        description: `${streamerId} - Fetching chat messages for ${vodId}${startOffset ? ' (resuming from offset ' + startOffset + 's)' : ''}`,
        status: 'warning',
        fields: [
          { name: 'Platform', value: platform, inline: true },
          { name: 'VOD ID', value: vodId, inline: false },
          ...(startOffset ? [{ name: 'Start Offset', value: startOffset + 's', inline: true }] : []),
        ],
        timestamp: new Date().toISOString(),
      })
    : null;

  try {
    let cursor: string | null = null;
    let totalMessages = 0;
    let batchCount = 0;
    const initialOffset = startOffset || 0;

    log.info('[' + vodId + '] Starting chat download' + (initialOffset > 0 ? ' from offset ' + initialOffset + 's' : ''));

    while (true) {
      let page: any;

      if (cursor === null) {
        page = await fetchComments(vodId, initialOffset);
      } else {
        await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
        page = await fetchNextComments(vodId, cursor);
      }

      if (!page || !page.comments?.edges) {
        break;
      }

      const messagesToInsert = page.comments.edges.map((edge: any) => {
        const node = edge.node;
        const { message, userBadges } = extractMessageData(node);

        return {
          id: vodId + '-' + (node.content_offset_seconds || 0) + '-' + (node.sender?.login || 'unknown'),
          vod_id: vodId,
          display_name: node.commenter?.display_name,
          content_offset_seconds: node.content_offset_seconds,
          created_at: node.created_at ? new Date(node.created_at) : null,
          updated_at: node.updated_at ? new Date(node.updated_at) : null,
          message,
          user_badges: userBadges,
          user_color: node.message?.user_color || '#FFFFFF',
        };
      });

      for (const msg of messagesToInsert) {
        await db.chatMessage.upsert({
          where: { id: msg.id },
          create: msg,
          update: {},
        });
      }

      totalMessages += messagesToInsert.length;
      batchCount++;

      if (messageId && isAlertsEnabled() && batchCount * 50 >= BATCH_SIZE) {
        const percent = Math.min(Math.round((totalMessages / ((duration / 60) * 50)) * 100), 100);
        updateDiscordEmbed(messageId, {
          title: '💬 Downloading Chat',
          description: streamerId + ' - Fetching chat messages for ' + vodId,
          status: 'warning',
          fields: [
            { name: 'Messages Fetched', value: String(totalMessages), inline: true },
            { name: 'Progress', value: formatProgressMessage('Chat Download', streamerId, percent, totalMessages), inline: false },
          ],
          timestamp: new Date().toISOString(),
          updatedTimestamp: new Date().toISOString(),
        });

        batchCount = 0;
      }

      cursor = page.cursor;
      if (!cursor) {
        break;
      }

      await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
    }

    resetFailures(streamerId);

    if (messageId && isAlertsEnabled()) {
      updateDiscordEmbed(messageId, {
        title: '[Chat] Download Complete',
        description: streamerId + ' - Successfully fetched ' + totalMessages.toLocaleString() + ' chat messages for ' + vodId,
        status: 'success',
        fields: [
          { name: 'Platform', value: platform, inline: true },
          { name: 'Total Messages', value: String(totalMessages), inline: false },
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
        description: streamerId + ' - Error fetching chat messages for ' + vodId,
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
