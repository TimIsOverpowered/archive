import type { PrismaClient } from '../../../generated/streamer/client';
import type { ChatMessageCreateInput } from './chat-types.js';
import type { AppLogger } from '../../utils/logger.js';
import { retryWithBackoff } from '../../utils/retry.js';
import { CHAT_MAX_RETRIES, CHAT_RETRY_DELAY_MS } from '../../constants.js';

export interface FlushBatchResult {
  totalMessages: number;
  batchCount: number;
}

export interface FlushBatchOptions {
  db: PrismaClient;
  buffer: ChatMessageCreateInput[];
  log: AppLogger;
  vodId: string;
  onProgress?: (offset: number, batchNumber: number, messagesInBatch: number) => void;
  lastOffset: number;
  totalMessages: number;
  batchCount: number;
}

export async function flushChatBatch(options: FlushBatchOptions): Promise<FlushBatchResult> {
  const { db, buffer, log, vodId, onProgress, lastOffset, totalMessages, batchCount } = options;

  if (buffer.length === 0) {
    return { totalMessages, batchCount };
  }

  await retryWithBackoff(() => db.chatMessage.createMany({ data: buffer, skipDuplicates: true }), {
    attempts: CHAT_MAX_RETRIES,
    baseDelayMs: CHAT_RETRY_DELAY_MS,
  });

  const newTotalMessages = totalMessages + buffer.length;
  const newBatchCount = batchCount + 1;

  log.debug(
    {
      vodId,
      batchNumber: newBatchCount,
      messagesInBatch: buffer.length,
      totalMessages: newTotalMessages,
    },
    '[Chat] Batch flushed to database'
  );

  onProgress?.(lastOffset, newBatchCount, buffer.length);

  buffer.length = 0;
  return { totalMessages: newTotalMessages, batchCount: newBatchCount };
}
