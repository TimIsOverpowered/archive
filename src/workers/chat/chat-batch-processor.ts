import type { Kysely } from 'kysely';
import { Chat } from '../../constants.js';
import type { StreamerDB, InsertableChatMessages } from '../../db/streamer-types.js';
import type { AppLogger } from '../../utils/logger.js';
import { retryWithBackoff } from '../../utils/retry.js';
import type { ChatMessageCreateInput } from './chat-types.js';

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
  forceRerun?: boolean;
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
  const { db, buffer, log, vodId, onProgress, lastOffset, totalMessages, batchCount, forceRerun } = options;

  if (buffer.length === 0) {
    return { totalMessages, batchCount };
  }

  const insertQuery = db
    .insertInto('chat_messages')
    .values(buffer.map(toInsertableChatMessage))
    .onConflict((oc) =>
      forceRerun === true
        ? oc.columns(['id', 'created_at']).doUpdateSet({
            display_name: (eb) => eb.ref('excluded.display_name'),
            content_offset_seconds: (eb) => eb.ref('excluded.content_offset_seconds'),
            user_color: (eb) => eb.ref('excluded.user_color'),
            message: (eb) => eb.ref('excluded.message'),
            user_badges: (eb) => eb.ref('excluded.user_badges'),
          })
        : oc.columns(['id', 'created_at']).doNothing()
    );

  await retryWithBackoff(() => insertQuery.execute(), {
    attempts: Chat.MAX_RETRIES,
    baseDelayMs: Chat.RETRY_DELAY_MS,
  });

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
