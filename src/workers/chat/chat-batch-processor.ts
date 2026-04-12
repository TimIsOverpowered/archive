import type { PrismaClient } from '../../../generated/streamer/client';
import type { ChatMessageCreateInput } from './chat-types.js';
import type { AppLogger } from '../../utils/auto-tenant-logger.js';
import { sleep } from '../../utils/delay.js';
import { updateAlert, formatProgressMessage } from '../../utils/discord-alerts.js';
import { extractErrorDetails } from '../../utils/error.js';
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
  tenantId: string;
  messageId: string | null;
  duration: number;
  lastOffset: number;
  totalMessages: number;
  batchCount: number;
}

export async function flushChatBatch(options: FlushBatchOptions): Promise<FlushBatchResult> {
  const { db, buffer, log, vodId, tenantId, messageId, duration, lastOffset, totalMessages, batchCount } = options;

  if (buffer.length === 0) {
    return { totalMessages, batchCount };
  }

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= CHAT_MAX_RETRIES; attempt++) {
    try {
      await db.chatMessage.createMany({
        data: buffer,
        skipDuplicates: true,
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

      if (messageId) {
        const percent = duration > 0 ? Math.min(Math.round((lastOffset / duration) * 100), 100) : 0;

        void updateAlert(messageId, {
          title: '💬 Downloading Chat',
          description: `${tenantId} chat download for ${vodId}`,
          status: 'warning',
          fields: [
            { name: 'Current Offset', value: `${lastOffset.toFixed(2)}s`, inline: true },
            { name: 'Batch', value: `#${newBatchCount} (${buffer.length} messages)`, inline: true },
            {
              name: 'Progress',
              value: formatProgressMessage('Chat Download', tenantId, percent, newTotalMessages),
              inline: false,
            },
          ],
          timestamp: new Date().toISOString(),
          updatedTimestamp: new Date().toISOString(),
        });
      }

      buffer.length = 0;
      return { totalMessages: newTotalMessages, batchCount: newBatchCount };
    } catch (error) {
      lastError = error as Error;
      log.warn(
        {
          vodId,
          attempt,
          maxRetries: CHAT_MAX_RETRIES,
          bufferLength: buffer.length,
          error: extractErrorDetails(error).message,
        },
        '[Chat] Batch flush failed, retrying...'
      );

      if (attempt < CHAT_MAX_RETRIES) {
        await sleep(CHAT_RETRY_DELAY_MS * attempt);
      }
    }
  }

  log.error({ vodId, bufferLength: buffer.length }, '[Chat] Batch flush failed after all retries');
  throw lastError || new Error('Batch flush failed');
}
