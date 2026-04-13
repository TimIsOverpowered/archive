import type { UploadProgressCallbackData } from '../../services/youtube/index.js';
import { extractErrorDetails } from '../../utils/error.js';
import { updateDiscordEmbed, isAlertsEnabled } from '../../utils/discord-alerts.js';
import type { UploadType } from '../../types/platforms.js';
import { UPLOAD_TYPES } from '../../types/platforms.js';

interface UploadProgressOptions {
  messageId: string | null;
  type: UploadType;
  channelName: string;
  videoTitle?: string;
  gameName?: string;
  part?: number;
  totalParts?: number;
}

export function createYoutubeUploadProgressHandler({
  messageId,
  type,
  channelName,
  videoTitle,
  gameName,
  part,
  totalParts,
}: UploadProgressOptions): (progress: UploadProgressCallbackData) => Promise<void> {
  return async (progress: UploadProgressCallbackData) => {
    if (!messageId || !isAlertsEnabled()) return;

    const partSuffix = part !== undefined && totalParts !== undefined ? ` Part ${part}/${totalParts}` : '';
    const partField = part !== undefined && totalParts !== undefined ? { name: 'Part', value: `${part}/${totalParts}`, inline: true } : undefined;

    switch (progress.milestone) {
      case 'starting': {
        const titlePrefix = type === UPLOAD_TYPES.VOD ? '📺 Uploading VOD' : '🎮 Uploading Game Clip';
        const title = type === UPLOAD_TYPES.VOD ? `${titlePrefix}${partSuffix}` : `${titlePrefix}${partSuffix}`;
        const videoField = videoTitle ? { name: 'Video', value: videoTitle.substring(0, 150), inline: false } : undefined;
        const gameField = gameName ? { name: 'Game', value: gameName.substring(0, 150), inline: true } : undefined;

        const fields: Array<{ name: string; value: string; inline: boolean }> = [];
        if (gameField) fields.push(gameField);
        if (videoField) fields.push(videoField);
        if (partField) fields.push(partField);

        await updateDiscordEmbed(messageId, {
          title,
          description: `${channelName} - Initializing upload stream...`,
          status: 'warning',
          fields,
          timestamp: new Date().toISOString(),
        });
        break;
      }

      case 'processing_metadata': {
        const titlePrefix = type === UPLOAD_TYPES.VOD ? '🔄 Processing VOD' : '🔄 Processing Game Clip';
        const title = type === UPLOAD_TYPES.VOD ? `${titlePrefix}${partSuffix}` : `${titlePrefix}${partSuffix}`;

        const fields: Array<{ name: string; value: string; inline: boolean }> = [{ name: 'Video ID', value: progress.videoId || '', inline: false }];
        if (partField) fields.push(partField);

        await updateDiscordEmbed(messageId, {
          title,
          description: `${channelName} - Fetching video metadata & thumbnails...`,
          status: 'warning',
          fields,
          timestamp: new Date().toISOString(),
        });
        break;
      }

      case 'success': {
        const titlePrefix = type === UPLOAD_TYPES.VOD ? '✅ VOD Upload Complete' : '✅ Game Upload Complete';
        const title = type === UPLOAD_TYPES.VOD ? `${titlePrefix}${partSuffix}` : `${titlePrefix}${partSuffix}`;

        const fields: Array<{ name: string; value: string; inline: boolean }> = [
          { name: '', value: progress.thumbnailUrl || '', inline: false },
          { name: 'Video ID', value: (progress.videoId || '').substring(0, 12) + '...', inline: false },
        ];
        if (partField) fields.push(partField);

        await updateDiscordEmbed(messageId, {
          title,
          description: `${channelName} - Successfully uploaded to YouTube!`,
          status: 'success',
          fields,
          timestamp: new Date().toISOString(),
        });
        break;
      }

      case 'error': {
        if (progress.errorDetails) {
          const errorMsg = extractErrorDetails(progress.errorDetails).message;

          const fields: Array<{ name: string; value: string; inline: boolean }> = [{ name: 'Error', value: errorMsg.substring(0, 500), inline: false }];
          if (partField) fields.push(partField);

          await updateDiscordEmbed(messageId, {
            title: `❌ ${type === UPLOAD_TYPES.VOD ? 'VOD' : 'Game'} Upload Failed${partSuffix}`,
            description: `${channelName} - Video upload encountered an error`,
            status: 'error',
            fields,
            timestamp: new Date().toISOString(),
          });
        }
        break;
      }
    }
  };
}
