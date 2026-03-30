import { Processor, Job } from 'bullmq';
import { getClient, createClient } from '../db/client';
import { getStreamerConfig } from '../config/loader';
import { fetchComments, fetchNextComments } from '../services/twitch';
import { sendRichAlert, updateDiscordEmbed, formatProgressMessage, resetFailures, isAlertsEnabled } from '../utils/alerts';
import { ChatDownloadJob } from '../jobs/queues';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';

const BATCH_SIZE = 2500;
const RATE_LIMIT_MS = 150;

const chatProcessor: Processor<ChatDownloadJob> = async (job: Job<ChatDownloadJob>) => {
  const { streamerId, vodId, platform, duration } = job.data;

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
        description: `${streamerId} - Fetching chat messages for ${vodId}`,
        status: 'warning',
        fields: [
          { name: 'Platform', value: platform, inline: true },
          { name: 'VOD ID', value: vodId, inline: false },
        ],
        timestamp: new Date().toISOString(),
      })
    : null;

  try {
    let cursor: string | null = null;
    let totalMessages = 0;
    let batchCount = 0;

    while (true) {
      let page: any;

      if (cursor === null) {
        page = await fetchComments(vodId, 0);
      } else {
        await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
        page = await fetchNextComments(vodId, cursor);
      }

      if (!page || page.comments.length === 0) {
        break;
      }

      const messagesToInsert = page.comments.map((c: any) => ({
        id: `${vodId}-${c.content_offset_seconds}-${c.sender.login}`,
        vod_id: vodId,
        display_name: c.sender.display_name,
        content_offset_seconds: c.content_offset_seconds,
        message: { content: c.comment.content },
        user_badges: {},
        user_color: '#FFFFFF',
      }));

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
          title: `💬 Downloading Chat`,
          description: `${streamerId} - Fetching chat messages for ${vodId}`,
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
        title: `✅ Chat Download Complete`,
        description: `${streamerId} - Successfully fetched ${totalMessages.toLocaleString()} chat messages for ${vodId}`,
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
    log.error({ vodId, platform }, `Chat download failed: ${(error as Error).message}`);

    if (messageId && isAlertsEnabled()) {
      updateDiscordEmbed(messageId, {
        title: `❌ Chat Download Failed`,
        description: `${streamerId} - Error fetching chat messages for ${vodId}`,
        status: 'error',
        fields: [
          { name: 'Platform', value: platform, inline: true },
          { name: 'Error', value: (error as Error).message.substring(0, 500), inline: false },
        ],
        timestamp: new Date().toISOString(),
        updatedTimestamp: new Date().toISOString(),
      });
    }

    throw error;
  }
};

export default chatProcessor;
