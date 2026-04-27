import type { Kysely } from 'kysely';
import type { StreamerDB, InsertableChatMessages } from '../../db/streamer-types.js';
import type { ChatMessageCreateInput } from './chat-types.js';
import type { AppLogger } from '../../utils/logger.js';
import { retryWithBackoff } from '../../utils/retry.js';
import { CHAT_MAX_RETRIES, CHAT_RETRY_DELAY_MS } from '../../constants.js';

export interface FlushBatchResult {
  totalMessages: number;
  batchCount: number;
}

export interface FlushBatchOptions {
  db: Kysely<StreamerDB>;
  buffer: ChatMessageCreateInput[];
  log: AppLogger;
  vodId: string;
  onProgress?: (offset: number, batchNumber: number, messagesInBatch: number) => void;
  lastOffset: number;
  totalMessages: number;
  batchCount: number;
}

function toInsertableChatMessage(msg: ChatMessageCreateInput): InsertableChatMessages {
  return {
    id: msg.id,
    vod_id: msg.vod_id,
    display_name: msg.display_name,
    content_offset_seconds: msg.content_offset_seconds,
    user_color: msg.user_color,
    created_at: msg.createdAt.toISOString(),
    message: msg.message != null ? JSON.stringify(msg.message) : null,
    user_badges: msg.user_badges != null ? JSON.stringify(msg.user_badges) : null,
  };
}

export async function flushChatBatch(options: FlushBatchOptions): Promise<FlushBatchResult> {
  const { db, buffer, log, vodId, onProgress, lastOffset, totalMessages, batchCount } = options;

  if (buffer.length === 0) {
    return { totalMessages, batchCount };
  }

  await retryWithBackoff(
    () =>
      db
        .insertInto('chat_messages')
        .values(buffer.map(toInsertableChatMessage))
        .onConflict((oc) => oc.columns(['id', 'created_at']).doNothing())
        .execute(),
    {
      attempts: CHAT_MAX_RETRIES,
      baseDelayMs: CHAT_RETRY_DELAY_MS,
    }
  );

  const newTotalMessages = totalMessages + buffer.length;
  const newBatchCount = batchCount + 1;

  log.debug(
    {
      component: 'chat-worker',
      vodId,
      batchNumber: newBatchCount,
      messagesInBatch: buffer.length,
      totalMessages: newTotalMessages,
    },
    'Batch flushed to database'
  );

  onProgress?.(lastOffset, newBatchCount, buffer.length);

  buffer.length = 0;
  return { totalMessages: newTotalMessages, batchCount: newBatchCount };
}
