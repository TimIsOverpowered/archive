/**
 * Alert factories for standardized worker alerts.
 * Each factory provides init, progress, complete, and error alert builders.
 */

import { toHHMMSS } from '../../utils/formatting.js';
import type { RichEmbedData } from '../../utils/discord-alerts.js';
import { createProgressBar } from '../../utils/discord-alerts.js';
import { capitalizePlatform, Platform } from '../../types/platforms.js';

export interface LiveCompletionData {
  emotesSaved: boolean;
  chatJobId: string | null;
  youtubeVodJobId: string | null;
  youtubeGameJobIds: string[];
  segmentCount: number;
  finalPath: string;
}

// ============================================================================
// VOD Worker Alerts
// ============================================================================

export interface VodWorkerAlerts {
  init: (vodId: string, platform: Platform, streamerName: string) => RichEmbedData;
  progress: (vodId: string, message: string) => RichEmbedData;
  complete: (vodId: string, platform: Platform, finalPath: string) => RichEmbedData;
  error: (vodId: string, platform: Platform, errorMsg: string) => RichEmbedData;
}

export function createVodWorkerAlerts(): VodWorkerAlerts {
  return {
    init: (vodId, platform, streamerName) => ({
      title: `[VOD] ${vodId} Started`,
      description: `${capitalizePlatform(platform)} VOD download started`,
      status: 'warning',
      fields: [
        { name: 'Platform', value: capitalizePlatform(platform), inline: true },
        { name: 'Streamer', value: streamerName, inline: true },
      ],
      timestamp: new Date().toISOString(),
    }),

    progress: (vodId, message) => ({
      title: `[VOD] ${vodId} In Progress`,
      description: message,
      status: 'warning',
      fields: [{ name: 'VOD ID', value: vodId, inline: false }],
      timestamp: new Date().toISOString(),
    }),

    complete: (vodId, platform, finalPath) => ({
      title: `[VOD] ${vodId} Complete`,
      description: 'Successfully downloaded',
      status: 'success',
      fields: [
        { name: 'Platform', value: capitalizePlatform(platform), inline: true },
        { name: 'Path', value: finalPath, inline: false },
      ],
      timestamp: new Date().toISOString(),
    }),

    error: (vodId, platform, errorMsg) => ({
      title: `[VOD] ${vodId} FAILED`,
      description: errorMsg,
      status: 'error',
      fields: [{ name: 'Platform', value: capitalizePlatform(platform), inline: true }],
      timestamp: new Date().toISOString(),
    }),
  };
}

// ============================================================================
// Live Worker Alerts
// ============================================================================

export interface LiveWorkerAlerts {
  init: (vodId: string, platform: Platform, streamerName: string, startedAt?: string) => RichEmbedData;
  progress: (vodId: string, segmentsDownloaded: number) => RichEmbedData;
  converting: (vodId: string, segmentCount: number) => RichEmbedData;
  emotesSaved: (vodId: string) => RichEmbedData;
  chatQueued: (vodId: string) => RichEmbedData;
  uploadQueued: (vodId: string) => RichEmbedData;
  complete: (vodId: string, duration?: number, completionData?: LiveCompletionData) => RichEmbedData;
  error: (vodId: string, errorMsg: string) => RichEmbedData;
}

export function createLiveWorkerAlerts(): LiveWorkerAlerts {
  return {
    init: (vodId, platform, streamerName, startedAt) => ({
      title: `[Live] ${vodId} Started`,
      description: `${capitalizePlatform(platform)} live stream download started`,
      status: 'warning',
      fields: [
        { name: 'Platform', value: capitalizePlatform(platform), inline: true },
        { name: 'Streamer', value: streamerName, inline: true },
        ...(startedAt ? [{ name: 'Started At', value: startedAt, inline: false }] : []),
      ],
      timestamp: new Date().toISOString(),
    }),

    progress: (vodId, segmentsDownloaded) => ({
      title: `[Live] Downloading ${vodId}`,
      description: `${segmentsDownloaded} segments downloaded`,
      status: 'warning',
      fields: [],
      timestamp: new Date().toISOString(),
    }),

    converting: (vodId, segmentCount) => ({
      title: `[Live] Converting ${vodId}`,
      description: 'Download complete. Converting...',
      status: 'warning',
      fields: [{ name: 'Segments', value: String(segmentCount), inline: true }],
      timestamp: new Date().toISOString(),
    }),

    emotesSaved: (vodId) => ({
      title: `[Live] ${vodId} Emotes Saved`,
      description: 'Emote data successfully saved',
      status: 'success',
      fields: [],
      timestamp: new Date().toISOString(),
    }),

    chatQueued: (vodId) => ({
      title: `[Live] ${vodId} Chat Download Queued`,
      description: 'Chat download job has been queued',
      status: 'warning',
      fields: [],
      timestamp: new Date().toISOString(),
    }),

    uploadQueued: (vodId) => ({
      title: `[Live] ${vodId} Upload Queued`,
      description: 'YouTube upload has been queued',
      status: 'warning',
      fields: [],
      timestamp: new Date().toISOString(),
    }),

    complete: (vodId, duration, completionData) => {
      const fields: Array<{ name: string; value: string; inline: boolean }> = [];

      fields.push({ name: 'Duration', value: duration ? toHHMMSS(duration) : 'Unknown', inline: true });

      if (completionData) {
        if (completionData.emotesSaved) {
          fields.push({ name: 'Emotes', value: '✅ Saved', inline: true });
        }

        if (completionData.chatJobId) {
          fields.push({ name: 'Chat Job', value: completionData.chatJobId, inline: false });
        }

        if (completionData.youtubeVodJobId) {
          fields.push({ name: 'VOD Upload Job', value: completionData.youtubeVodJobId, inline: false });
        }

        if (completionData.youtubeGameJobIds.length > 0) {
          fields.push({
            name: 'Game Upload Jobs',
            value: completionData.youtubeGameJobIds.join(', '),
            inline: false,
          });
        }

        fields.push({ name: 'Segments', value: String(completionData.segmentCount), inline: true });
        fields.push({ name: 'Output', value: completionData.finalPath, inline: false });
      }

      return {
        title: `[Live] ${vodId} Complete`,
        description: 'Successfully processed',
        status: 'success',
        fields,
        timestamp: new Date().toISOString(),
      };
    },

    error: (vodId, errorMsg) => ({
      title: `[Live] ${vodId} FAILED`,
      description: errorMsg,
      status: 'error',
      fields: [],
      timestamp: new Date().toISOString(),
    }),
  };
}

// ============================================================================
// Chat Worker Alerts
// ============================================================================

export interface ChatWorkerAlerts {
  init: (tenantId: string, vodId: string, platform: Platform, isResume: boolean, offset?: number) => RichEmbedData;
  progress: (tenantId: string, vodId: string, offset: number, batchNumber: number, messagesInBatch: number, totalMessages: number, duration: number) => RichEmbedData;
  complete: (tenantId: string, vodId: string, platform: Platform, totalMessages: number, batchCount: number, startOffset?: number) => RichEmbedData;
  alreadyComplete: (tenantId: string, vodId: string, platform: Platform, totalMessages: number, lastOffset: number) => RichEmbedData;
  noMessages: (tenantId: string, vodId: string, platform: Platform, offset: number) => RichEmbedData;
  error: (tenantId: string, vodId: string, platform: Platform, totalMessages: number, errorMsg: string) => RichEmbedData;
}

export function createChatWorkerAlerts(): ChatWorkerAlerts {
  return {
    init: (tenantId, vodId, platform, isResume, offset) => ({
      title: isResume ? `💬 Chat Download Resumed` : `💬 Chat Download Started`,
      description: isResume ? `${tenantId} - Continuing from offset ${offset?.toFixed(2) ?? 0}s` : `${tenantId} - Fetching chat messages for ${vodId}`,
      status: 'warning',
      fields: [
        { name: 'Platform', value: capitalizePlatform(platform), inline: true },
        { name: 'VOD ID', value: String(vodId), inline: false },
        ...(offset ? [{ name: isResume ? 'Resume Offset' : 'Start Offset', value: `${offset.toFixed(2)}s`, inline: true }] : []),
      ],
      timestamp: new Date().toISOString(),
    }),

    progress: (tenantId, vodId, offset, batchNumber, messagesInBatch, totalMessages, duration) => {
      const percent = duration > 0 ? Math.min(Math.round((offset / duration) * 100), 100) : 0;
      const progressBar = createProgressBar(percent);

      return {
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
      };
    },

    alreadyComplete: (tenantId, vodId, platform, totalMessages, lastOffset) => ({
      title: '💬 Chat Download Already Complete',
      description: `${tenantId} - Chat download for ${vodId} is already complete`,
      status: 'success',
      fields: [
        { name: 'Platform', value: capitalizePlatform(platform), inline: true },
        { name: 'Total Messages', value: String(totalMessages), inline: true },
        { name: 'Last Offset', value: `${lastOffset.toFixed(2)}s`, inline: false },
      ],
      timestamp: new Date().toISOString(),
    }),

    complete: (tenantId, vodId, platform, totalMessages, batchCount, startOffset) => ({
      title: '💬 Chat Download Complete',
      description: `${tenantId} - Successfully downloaded ${totalMessages} chat messages for ${vodId}`,
      status: 'success',
      fields: [
        { name: 'Platform', value: capitalizePlatform(platform), inline: true },
        { name: 'Total Messages', value: String(totalMessages), inline: true },
        { name: 'Total Batches', value: String(batchCount), inline: true },
        ...(startOffset ? [{ name: startOffset ? 'Resume Point' : 'Auto-Resumed From', value: `${startOffset.toFixed(2)}s → Final offset reached`, inline: false }] : []),
      ],
      timestamp: new Date().toISOString(),
      updatedTimestamp: new Date().toISOString(),
    }),

    noMessages: (tenantId, vodId, platform, offset) => ({
      title: '[Chat] Download Complete',
      description: `${tenantId} - No chat messages found for VOD ${vodId}`,
      status: 'warning',
      fields: [
        { name: 'Platform', value: capitalizePlatform(platform), inline: true },
        { name: 'VOD ID', value: String(vodId), inline: false },
        { name: 'Offset', value: `${offset.toFixed(2)}s`, inline: true },
      ],
      timestamp: new Date().toISOString(),
      updatedTimestamp: new Date().toISOString(),
    }),

    error: (tenantId, vodId, platform, totalMessages, errorMsg) => ({
      title: '[Chat] Download Failed',
      description: `${tenantId} - Error fetching chat messages for VOD ${vodId}`,
      status: 'error',
      fields: [
        { name: 'Platform', value: capitalizePlatform(platform), inline: true },
        { name: 'Messages Processed Before Failure', value: String(totalMessages), inline: true },
        { name: 'Error', value: errorMsg, inline: false },
      ],
      timestamp: new Date().toISOString(),
      updatedTimestamp: new Date().toISOString(),
    }),
  };
}

// ============================================================================
// YouTube Worker Alerts
// ============================================================================

export interface YoutubeWorkerAlerts {
  splitting: (tenantId: string, vodId: string, totalParts: number, duration: number) => RichEmbedData;
  splittingProgress: (currentPart: number, totalParts: number) => RichEmbedData;
  uploadProgress: (vodId: string, part: number | null, percent: number) => RichEmbedData;
  complete: (vodId: string, videoIds: string[], parts?: number) => RichEmbedData;
  error: (vodId: string, errorMsg: string) => RichEmbedData;
}

export function createYoutubeWorkerAlerts(): YoutubeWorkerAlerts {
  return {
    splitting: (tenantId, vodId, totalParts, duration) => ({
      title: `📺 VOD Splitting in Progress`,
      description: `${tenantId} - Preparing ${totalParts} parts...`,
      status: 'warning',
      fields: [
        { name: 'VOD ID', value: vodId, inline: true },
        { name: 'Total Duration', value: toHHMMSS(duration), inline: true },
        { name: 'Parts Count', value: String(totalParts), inline: false },
      ],
      timestamp: new Date().toISOString(),
    }),

    splittingProgress: (currentPart, totalParts) => ({
      title: `📺 Splitting in Progress`,
      description: `Processing part ${currentPart} of ${totalParts}`,
      status: 'warning',
      fields: [],
      timestamp: new Date().toISOString(),
    }),

    uploadProgress: (vodId, part, percent) => ({
      title: `📺 Uploading to YouTube`,
      description: part ? `Part ${part}: ${percent}% complete` : `${vodId}: ${percent}% complete`,
      status: 'warning',
      fields: [],
      timestamp: new Date().toISOString(),
    }),

    complete: (vodId, videoIds, parts) => ({
      title: `✅ YouTube Upload Complete`,
      description: parts ? `Successfully uploaded ${parts} parts for ${vodId}` : `Successfully uploaded ${vodId}`,
      status: 'success',
      fields: [{ name: 'Video ID(s)', value: videoIds.slice(0, 3).join(', '), inline: false }, ...(parts ? [{ name: 'Total Parts', value: String(parts), inline: true }] : [])],
      timestamp: new Date().toISOString(),
    }),

    error: (vodId, errorMsg) => ({
      title: `❌ YouTube Upload Failed`,
      description: `Failed to upload ${vodId}`,
      status: 'error',
      fields: [{ name: 'Error', value: errorMsg.substring(0, 500), inline: false }],
      timestamp: new Date().toISOString(),
    }),
  };
}

// ============================================================================
// DMCA Worker Alerts
// ============================================================================

export interface DmcaWorkerAlerts {
  processing: (vodId: string, claimCount: number, part?: number) => RichEmbedData;
  complete: (vodId: string, youtubeJobId: string) => RichEmbedData;
  error: (vodId: string, errorMsg: string) => RichEmbedData;
}

export function createDmcaWorkerAlerts(): DmcaWorkerAlerts {
  return {
    processing: (vodId, claimCount, part) => ({
      title: `⚖️ DMCA Processing ${vodId}`,
      description: part ? `Processing part ${part} with ${claimCount} claims` : `Processing ${claimCount} claims`,
      status: 'warning',
      fields: [{ name: 'VOD ID', value: vodId, inline: false }],
      timestamp: new Date().toISOString(),
    }),

    complete: (vodId, youtubeJobId) => ({
      title: `✅ DMCA Processing Complete`,
      description: `Successfully processed ${vodId}`,
      status: 'success',
      fields: [
        { name: 'VOD ID', value: vodId, inline: false },
        { name: 'Upload Job ID', value: youtubeJobId, inline: false },
      ],
      timestamp: new Date().toISOString(),
    }),

    error: (vodId, errorMsg) => ({
      title: `❌ DMCA Processing Failed`,
      description: `Failed to process ${vodId}`,
      status: 'error',
      fields: [
        { name: 'VOD ID', value: vodId, inline: false },
        { name: 'Error', value: errorMsg.substring(0, 500), inline: false },
      ],
      timestamp: new Date().toISOString(),
    }),
  };
}
