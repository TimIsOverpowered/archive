import type { UploadProgressCallbackData } from '../../services/youtube/index.js';
import type { UploadType } from '../../types/platforms.js';
import { UPLOAD_TYPES } from '../../types/platforms.js';
import { updateDiscordEmbed, isAlertsEnabled, createProgressBar } from '../../utils/discord-alerts.js';
import { extractErrorDetails } from '../../utils/error.js';
import { toHHMMSS } from '../../utils/formatting.js';

interface UploadProgressOptions {
  messageId: string | null;
  type: UploadType;
  channelName: string;
  videoTitle?: string;
  gameName?: string;
  part?: number;
  totalParts?: number;
  privacyStatus?: 'public' | 'unlisted' | 'private';
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let unitIndex = 0;
  let size = bytes;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

export function createYoutubeUploadProgressHandler({
  messageId,
  type,
  channelName,
  videoTitle,
  gameName,
  part,
  totalParts,
  privacyStatus,
}: UploadProgressOptions): (progress: UploadProgressCallbackData) => Promise<void> {
  return async (progress: UploadProgressCallbackData) => {
    if (messageId == null || !isAlertsEnabled()) return;

    const partSuffix = part !== undefined && totalParts !== undefined ? ` Part ${part}/${totalParts}` : '';
    const partField =
      part !== undefined && totalParts !== undefined
        ? { name: 'Part', value: `${part}/${totalParts}`, inline: true }
        : undefined;

    switch (progress.milestone) {
      case 'starting': {
        const titlePrefix = type === UPLOAD_TYPES.VOD ? '📺 Uploading VOD' : '🎮 Uploading Game';
        const title = `${titlePrefix}${partSuffix}`;
        const videoField =
          videoTitle != null ? { name: 'Video', value: videoTitle.substring(0, 150), inline: false } : undefined;
        const gameField =
          gameName != null ? { name: 'Game', value: gameName.substring(0, 150), inline: true } : undefined;

        const fields: Array<{ name: string; value: string; inline: boolean }> = [];
        if (gameField) fields.push(gameField);
        if (videoField) fields.push(videoField);
        if (partField) fields.push(partField);
        if (privacyStatus != null) {
          const privacyLabel = privacyStatus.charAt(0).toUpperCase() + privacyStatus.slice(1);
          fields.push({ name: 'Privacy', value: privacyLabel, inline: true });
        }

        await updateDiscordEmbed(messageId, {
          title,
          description: `${channelName} - Initializing upload stream...`,
          status: 'warning',
          fields,
          timestamp: new Date().toISOString(),
        });
        break;
      }

      case 'uploading': {
        const titlePrefix = type === UPLOAD_TYPES.VOD ? '📺 Uploading VOD' : '🎮 Uploading Game';
        const title = `${titlePrefix}${partSuffix}`;

        const percent = progress.percent ?? 0;
        const bytesUploaded = progress.bytesUploaded ?? 0;
        const totalBytes = progress.totalBytes ?? 0;
        const speedBps = progress.uploadSpeedBps ?? 0;
        const etaSeconds = progress.etaSeconds ?? 0;

        const fields: Array<{ name: string; value: string; inline: boolean }> = [
          {
            name: 'Progress',
            value: createProgressBar(percent),
            inline: false,
          },
          {
            name: 'Uploaded',
            value: `${formatBytes(bytesUploaded)} / ${totalBytes > 0 ? formatBytes(totalBytes) : 'N/A'}`,
            inline: false,
          },
        ];

        if (speedBps > 0) {
          fields.push({
            name: 'Speed',
            value: `${formatBytes(speedBps)}/s`,
            inline: true,
          });
          fields.push({
            name: 'ETA',
            value: toHHMMSS(Math.max(0, etaSeconds)),
            inline: true,
          });
        }

        if (partField) fields.unshift(partField);

        await updateDiscordEmbed(messageId, {
          title,
          description: `${channelName} - Uploading video to YouTube...`,
          status: 'warning',
          fields,
          timestamp: new Date().toISOString(),
        });
        break;
      }

      case 'processing_metadata': {
        const titlePrefix = type === UPLOAD_TYPES.VOD ? '🔄 Processing VOD' : '🔄 Processing Game';
        const title = `${titlePrefix}${partSuffix}`;

        const fields: Array<{ name: string; value: string; inline: boolean }> = [
          { name: 'Video ID', value: progress.videoId ?? '', inline: false },
        ];
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
        const title = `${titlePrefix}${partSuffix}`;

        const youtubeVideoUrl = progress.videoId != null ? `https://www.youtube.com/watch?v=${progress.videoId}` : '';

        const fields: Array<{ name: string; value: string; inline: boolean }> = [];

        if (progress.videoDuration !== undefined) {
          fields.push({ name: 'Duration', value: toHHMMSS(progress.videoDuration), inline: true });
        }

        if (videoTitle != null) {
          fields.push({ name: 'Title', value: videoTitle.substring(0, 256), inline: false });
        }

        if (progress.privacyStatus != null) {
          const privacyLabel = progress.privacyStatus.charAt(0).toUpperCase() + progress.privacyStatus.slice(1);
          fields.push({ name: 'Privacy', value: privacyLabel, inline: true });
        }

        if (partField) fields.push(partField);

        await updateDiscordEmbed(messageId, {
          title,
          description: `${channelName} - Successfully uploaded to YouTube!`,
          status: 'success',
          fields,
          thumbnailUrl: progress.thumbnailUrl,
          url: youtubeVideoUrl,
          timestamp: new Date().toISOString(),
        });
        break;
      }

      case 'error': {
        if (progress.errorDetails) {
          const errorMsg = extractErrorDetails(progress.errorDetails).message;

          const fields: Array<{ name: string; value: string; inline: boolean }> = [
            { name: 'Error', value: errorMsg.substring(0, 500), inline: false },
          ];
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
