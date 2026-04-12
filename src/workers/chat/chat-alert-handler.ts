import { updateAlert, createProgressBar } from '../../utils/discord-alerts.js';

export interface ChatAlertContext {
  messageId: string | null;
  tenantId: string;
  vodId: string;
  platform: 'twitch' | 'kick';
  duration: number;
}

export function createChatAlertHandler(ctx: ChatAlertContext) {
  const { messageId, tenantId, vodId, platform, duration } = ctx;

  return {
    updateProgress: (offset: number, batchNumber: number, messagesInBatch: number, _totalMessages: number) => {
      if (!messageId) return;

      const percent = duration > 0 ? Math.min(Math.round((offset / duration) * 100), 100) : 0;
      const progressBar = createProgressBar(percent);

      void updateAlert(messageId, {
        title: '💬 Downloading Chat',
        description: `${tenantId} chat download for ${vodId}`,
        status: 'warning',
        fields: [
          { name: 'Current Offset', value: `${offset.toFixed(2)}s`, inline: true },
          { name: 'Batch', value: `#${batchNumber} (${messagesInBatch} messages)`, inline: true },
          { name: 'Progress', value: `[Chat Download] ${tenantId} ${progressBar}`, inline: false },
        ],
        timestamp: new Date().toISOString(),
        updatedTimestamp: new Date().toISOString(),
      });
    },

    complete: (totalMessages: number, batchCount: number, startOffset?: number) => {
      if (!messageId) return;

      void updateAlert(messageId, {
        title: '💬 Chat Download Complete',
        description: `${tenantId} - Successfully downloaded ${totalMessages} chat messages for ${vodId}`,
        status: 'success',
        fields: [
          { name: 'Platform', value: platform, inline: true },
          { name: 'Total Messages', value: String(totalMessages), inline: true },
          { name: 'Total Batches', value: String(batchCount), inline: true },
          ...(startOffset ? [{ name: startOffset ? 'Resume Point' : 'Auto-Resumed From', value: `${startOffset.toFixed(2)}s → Final offset reached`, inline: false }] : []),
        ],
        timestamp: new Date().toISOString(),
        updatedTimestamp: new Date().toISOString(),
      });
    },

    noMessages: () => {
      if (!messageId) return;

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
    },

    error: (totalMessages: number, errorMsg: string) => {
      if (!messageId) return;

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
    },
  };
}
