import { Processor, Job } from 'bullmq';
import { getClient, createClient } from '../db/client';
import { getStreamerConfig } from '../config/loader';
import { fetchComments, fetchNextComments } from '../services/twitch';
import { sendDiscordAlert, updateDiscordMessage, formatProgressMessage, resetFailures, isAlertsEnabled } from '../utils/alerts';
import { ChatDownloadJob } from '../jobs/queues';

const BATCH_SIZE = 2500;
const RATE_LIMIT_MS = 150;

const chatProcessor: Processor<ChatDownloadJob> = async (job: Job<ChatDownloadJob>) => {
  const { streamerId, vodId, platform, duration } = job.data;

  if (platform !== 'twitch') {
    console.log(`Chat download for ${platform} is deferred`);
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

  const messageId = isAlertsEnabled() ? await sendDiscordAlert(`[Chat Download] ${streamerId} Starting...`) : null;

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
        await updateDiscordMessage(messageId, formatProgressMessage('Chat Download', streamerId, percent, totalMessages));
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
      await updateDiscordMessage(messageId, `[Chat Download] ${streamerId} Complete! (${totalMessages} messages)`);
    }

    return { success: true, totalMessages };
  } catch (error) {
    console.error(`Chat download failed for ${vodId}:`, error);

    if (messageId && isAlertsEnabled()) {
      await updateDiscordMessage(messageId, `[Chat Download] ${streamerId} FAILED: ${(error as Error).message}`);
    }

    throw error;
  }
};

export default chatProcessor;
