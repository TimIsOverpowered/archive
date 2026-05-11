/**
 * Alert factories for standardized worker alerts.
 * Each factory provides init, progress, complete, and error alert builders.
 */

import { capitalizePlatform, Platform, SOURCE_TYPES } from '../../types/platforms.js';
import { createProgressBar, updateAlert } from '../../utils/discord-alerts.js';
import type { RichEmbedData } from '../../utils/discord-alerts.js';
import { extractErrorDetails } from '../../utils/error.js';
import { formatBytes, toHHMMSS } from '../../utils/formatting.js';
import type { AppLogger } from '../../utils/logger.js';
import type { LiveCompletionData } from '../types.js';

/**
 * Safely updates a Discord alert, logging any errors without throwing.
 * This eliminates the repeated `void updateAlert(...).catch((err) => { log.warn(...) })` pattern.
 */
export function safeUpdateAlert(messageId: string | null, alert: RichEmbedData, log: AppLogger, vodId: string): void {
  void updateAlert(messageId, alert).catch((err) => {
    log.warn({ err: extractErrorDetails(err), vodId }, 'Discord alert update failed (non-critical)');
  });
}

// ============================================================================
// VOD Worker Alerts
// ============================================================================

export interface VodWorkerAlerts {
  init: (vodId: string, platform: Platform, streamerName: string) => RichEmbedData;
  progress: (vodId: string, segmentsDownloaded: number, totalSegments: number) => RichEmbedData;
  converting: (vodId: string, percent: number, ffmpegCmd?: string) => RichEmbedData;
  complete: (
    vodId: string,
    platform: Platform,
    finalPath: string,
    duration?: number,
    segmentCount?: number
  ) => RichEmbedData;
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

    progress: (vodId, segmentsDownloaded, totalSegments) => {
      const percent = totalSegments > 0 ? Math.round((segmentsDownloaded / totalSegments) * 100) : 0;
      const progressBar = createProgressBar(percent);

      return {
        title: `[VOD] ${vodId} In Progress`,
        description: `Downloading segments (${percent}%)`,
        status: 'warning',
        fields: [
          { name: 'Segments', value: `${segmentsDownloaded}/${totalSegments}`, inline: true },
          { name: 'Progress', value: progressBar, inline: false },
        ],
        timestamp: new Date().toISOString(),
      };
    },

    converting: (vodId, percent, ffmpegCmd) => {
      const fields: Array<{ name: string; value: string; inline: boolean }> = [
        { name: 'VOD ID', value: vodId, inline: true },
        { name: 'Progress', value: createProgressBar(percent), inline: false },
      ];

      if (ffmpegCmd != null) {
        fields.push({ name: 'FFmpeg', value: `\`${ffmpegCmd.substring(0, 500)}\``, inline: false });
      }

      return {
        title: `[VOD] ${vodId} Converting`,
        description: `Converting ${vodId}`,
        status: 'warning',
        fields,
        timestamp: new Date().toISOString(),
      };
    },

    complete: (vodId, platform, finalPath, duration, segmentCount) => {
      const fields: Array<{ name: string; value: string; inline: boolean }> = [
        { name: 'Platform', value: capitalizePlatform(platform), inline: true },
        { name: 'Duration', value: duration != null ? toHHMMSS(duration) : 'Unknown', inline: true },
      ];

      if (segmentCount != null) {
        fields.push({ name: 'Segments', value: String(segmentCount), inline: true });
      }

      fields.push({ name: 'Path', value: finalPath, inline: false });

      return {
        title: `[VOD] ${vodId} Complete`,
        description: 'Successfully downloaded',
        status: 'success',
        fields,
        timestamp: new Date().toISOString(),
      };
    },

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
  progress: (
    vodId: string,
    platform: Platform,
    streamerName: string,
    segmentsDownloaded: number,
    duration: number
  ) => RichEmbedData;
  converting: (vodId: string, percent: number, segmentCount?: number) => RichEmbedData;
  emotesSaved: (vodId: string, streamerName: string) => RichEmbedData;
  chatQueued: (vodId: string, streamerName: string) => RichEmbedData;
  uploadQueued: (vodId: string, streamerName: string) => RichEmbedData;
  complete: (vodId: string, duration?: number, completionData?: LiveCompletionData) => RichEmbedData;
  error: (vodId: string, errorMsg: string) => RichEmbedData;
}

export function createLiveWorkerAlerts(): LiveWorkerAlerts {
  return {
    init: (vodId, platform, streamerName, startedAt) => ({
      title: `[Live] ${streamerName} - ${vodId}`,
      description: `Downloading live stream from ${capitalizePlatform(platform)}`,
      status: 'warning',
      fields: [
        { name: 'Streamer', value: streamerName, inline: true },
        { name: 'Platform', value: capitalizePlatform(platform), inline: true },
        ...(startedAt != null ? [{ name: 'Started At', value: startedAt, inline: false }] : []),
      ],
      timestamp: new Date().toISOString(),
    }),

    progress: (vodId, platform, streamerName, segmentsDownloaded, duration) => {
      const progressBar = createProgressBar(25);

      return {
        title: `[Live] Downloading ${streamerName} - ${vodId}`,
        description: `Downloading segments from ${capitalizePlatform(platform)}...`,
        status: 'warning',
        fields: [
          { name: 'Streamer', value: streamerName, inline: true },
          { name: 'Platform', value: capitalizePlatform(platform), inline: true },
          { name: 'Segments', value: `${segmentsDownloaded}`, inline: true },
          { name: 'Duration', value: toHHMMSS(duration), inline: true },
          { name: 'Progress', value: progressBar, inline: false },
        ],
        timestamp: new Date().toISOString(),
      };
    },

    converting: (vodId, percent, segmentCount) => {
      const fields: Array<{ name: string; value: string; inline: boolean }> = [
        { name: 'Progress', value: createProgressBar(percent), inline: false },
      ];

      if (segmentCount != null) {
        fields.push({ name: 'Segments', value: String(segmentCount), inline: true });
      }

      return {
        title: `[Live] Converting ${vodId}`,
        description: `Download complete. Converting segments to MP4...`,
        status: 'warning',
        fields,
        timestamp: new Date().toISOString(),
      };
    },

    emotesSaved: (vodId, streamerName) => ({
      title: `[Live] ${streamerName} - Emotes Saved`,
      description: `Emote data successfully saved for ${vodId}`,
      status: 'success',
      fields: [{ name: 'VOD ID', value: vodId, inline: true }],
      timestamp: new Date().toISOString(),
    }),

    chatQueued: (vodId, streamerName) => ({
      title: `[Live] ${streamerName} - Chat Download Queued`,
      description: `Chat download job has been queued for ${vodId}`,
      status: 'warning',
      fields: [{ name: 'VOD ID', value: vodId, inline: true }],
      timestamp: new Date().toISOString(),
    }),

    uploadQueued: (vodId, streamerName) => ({
      title: `[Live] ${streamerName} - Upload Queued`,
      description: `YouTube upload has been queued for ${vodId}`,
      status: 'warning',
      fields: [{ name: 'VOD ID', value: vodId, inline: true }],
      timestamp: new Date().toISOString(),
    }),

    complete: (vodId, duration, completionData) => {
      const fields: Array<{ name: string; value: string; inline: boolean }> = [];

      if (completionData) {
        const streamerName = completionData.streamerName;
        const platform = completionData.platform;
        if (streamerName != null) {
          fields.push({ name: 'Streamer', value: streamerName, inline: true });
        }
        if (platform != null) {
          fields.push({ name: 'Platform', value: capitalizePlatform(platform), inline: true });
        }
      }

      fields.push({ name: 'Duration', value: duration != null ? toHHMMSS(duration) : 'Unknown', inline: true });

      if (completionData) {
        if (completionData.emotesSaved === true) {
          fields.push({ name: 'Emotes', value: '✅ Saved', inline: true });
        }

        if (completionData.chatJobId != null) {
          fields.push({ name: 'Chat Job', value: completionData.chatJobId, inline: false });
        }

        if (completionData.youtubeVodJobId != null) {
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
  init: (displayName: string, vodId: string, platform: Platform, isResume: boolean, offset?: number) => RichEmbedData;
  progress: (
    displayName: string,
    vodId: string,
    offset: number,
    batchNumber: number,
    messagesInBatch: number,
    totalMessages: number,
    duration: number
  ) => RichEmbedData;
  complete: (
    displayName: string,
    vodId: string,
    platform: Platform,
    totalMessages: number,
    batchCount: number,
    startOffset?: number
  ) => RichEmbedData;
  alreadyComplete: (
    displayName: string,
    vodId: string,
    platform: Platform,
    totalMessages: number,
    lastOffset: number
  ) => RichEmbedData;
  noMessages: (displayName: string, vodId: string, platform: Platform, offset: number) => RichEmbedData;
  error: (
    displayName: string,
    vodId: string,
    platform: Platform,
    totalMessages: number,
    errorMsg: string
  ) => RichEmbedData;
}

export function createChatWorkerAlerts(): ChatWorkerAlerts {
  return {
    init: (displayName, vodId, platform, isResume, offset) => ({
      title: isResume ? `💬 Chat Download Resumed` : `💬 Chat Download Started`,
      description: isResume
        ? `${displayName} - Continuing from offset ${offset?.toFixed(2) ?? 0}s`
        : `${displayName} - Fetching chat messages for ${vodId}`,
      status: 'warning',
      fields: [
        { name: 'Platform', value: capitalizePlatform(platform), inline: true },
        { name: 'VOD ID', value: String(vodId), inline: false },
        ...(offset != null
          ? [{ name: isResume ? 'Resume Offset' : 'Start Offset', value: `${offset.toFixed(2)}s`, inline: true }]
          : []),
      ],
      timestamp: new Date().toISOString(),
    }),

    progress: (displayName, vodId, offset, batchNumber, messagesInBatch, _totalMessages, duration) => {
      const percent = duration > 0 ? Math.min(Math.round((offset / duration) * 100), 100) : 0;
      const progressBar = createProgressBar(percent);

      return {
        title: '💬 Downloading Chat',
        description: `${displayName} chat download for ${vodId}`,
        status: 'warning',
        fields: [
          { name: 'Current Offset', value: `${offset.toFixed(2)}s`, inline: true },
          { name: 'Batch', value: `#${batchNumber} (${messagesInBatch} messages)`, inline: true },
          { name: 'Progress', value: `[Chat Download] ${displayName} ${progressBar}`, inline: false },
        ],
        timestamp: new Date().toISOString(),
        updatedTimestamp: new Date().toISOString(),
      };
    },

    alreadyComplete: (displayName, vodId, platform, totalMessages, lastOffset) => ({
      title: '💬 Chat Download Already Complete',
      description: `${displayName} - Chat download for ${vodId} is already complete`,
      status: 'success',
      fields: [
        { name: 'Platform', value: capitalizePlatform(platform), inline: true },
        { name: 'Total Messages', value: String(totalMessages), inline: true },
        { name: 'Last Offset', value: `${lastOffset.toFixed(2)}s`, inline: false },
      ],
      timestamp: new Date().toISOString(),
    }),

    complete: (displayName, vodId, platform, totalMessages, batchCount, startOffset) => ({
      title: '💬 Chat Download Complete',
      description: `${displayName} - Successfully downloaded ${totalMessages} chat messages for ${vodId}`,
      status: 'success',
      fields: [
        { name: 'Platform', value: capitalizePlatform(platform), inline: true },
        { name: 'Total Messages', value: String(totalMessages), inline: true },
        { name: 'Total Batches', value: String(batchCount), inline: true },
        ...(startOffset != null
          ? [
              {
                name: startOffset !== 0 ? 'Resume Point' : 'Auto-Resumed From',
                value: `${startOffset.toFixed(2)}s → Final offset reached`,
                inline: false,
              },
            ]
          : []),
      ],
      timestamp: new Date().toISOString(),
      updatedTimestamp: new Date().toISOString(),
    }),

    noMessages: (displayName, vodId, platform, offset) => ({
      title: '[Chat] Download Complete',
      description: `${displayName} - No chat messages found for VOD ${vodId}`,
      status: 'warning',
      fields: [
        { name: 'Platform', value: capitalizePlatform(platform), inline: true },
        { name: 'VOD ID', value: String(vodId), inline: false },
        { name: 'Offset', value: `${offset.toFixed(2)}s`, inline: true },
      ],
      timestamp: new Date().toISOString(),
      updatedTimestamp: new Date().toISOString(),
    }),

    error: (displayName, vodId, platform, totalMessages, errorMsg) => ({
      title: '[Chat] Download Failed',
      description: `${displayName} - Error fetching chat messages for VOD ${vodId}`,
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
// DMCA Worker Alerts
// ============================================================================

export interface DmcaClaimInfo {
  claimId?: string | undefined;
  identifier: string;
  startTimestamp: string;
  endTimestamp: string;
  claimType: string;
  policyType: string;
}

export interface DmcaWorkerAlerts {
  processing: (
    vodId: string,
    claims: DmcaClaimInfo[],
    platform: string,
    displayName: string,
    part?: number
  ) => RichEmbedData;
  progress: (
    vodId: string,
    claims: DmcaClaimInfo[],
    completedClaimIds: string[],
    currentStep: string,
    platform: string,
    displayName: string,
    stepProgress?: number,
    currentCommand?: string
  ) => RichEmbedData;
  complete: (
    vodId: string,
    youtubeJobId: string,
    claims: DmcaClaimInfo[],
    platform: string,
    displayName: string
  ) => RichEmbedData;
  error: (vodId: string, errorMsg: string) => RichEmbedData;
}

function formatClaimList(
  claims: DmcaClaimInfo[],
  completedClaimIds: string[],
  currentStep?: string,
  stepProgress?: number
): string {
  const lines: string[] = [];
  const sorted = [...claims].sort((a, b) => a.startTimestamp.localeCompare(b.startTimestamp));

  const claimTypeLabel: Record<string, string> = {
    CLAIM_TYPE_AUDIO: '🔊 Audio',
    CLAIM_TYPE_VISUAL: '👁️ Visual',
    CLAIM_TYPE_AUDIOVISUAL: '🎬 AudioVisual',
  };

  for (const claim of sorted) {
    const claimKey = claim.claimId ?? claim.identifier;
    const isCompleted = completedClaimIds.includes(claimKey);
    const isCurrent = !isCompleted && currentStep != null && currentStep.includes(claimKey ?? '');

    let prefix = '⏳';
    let suffix = '';

    if (isCompleted) {
      prefix = '✅';
    } else if (isCurrent) {
      prefix = '🔄';
      suffix = stepProgress != null ? ` (${stepProgress}%)` : '';
    }

    const timeRange = `${claim.startTimestamp} - ${claim.endTimestamp}`;
    const typeLabel = claimTypeLabel[claim.claimType] ?? claim.claimType;
    const policyLabel =
      claim.policyType !== '' && claim.policyType !== undefined ? claim.policyType.replace('POLICY_TYPE_', '') : '';
    const labels = [typeLabel, policyLabel].filter(Boolean).join(' | ');
    lines.push(`${prefix} ${claim.identifier} \`${timeRange}\` ${labels}${suffix}`);
  }

  return lines.join('\n');
}

export function createDmcaWorkerAlerts(): DmcaWorkerAlerts {
  return {
    processing: (vodId, claims, platform, displayName, part) => {
      const claimList = formatClaimList(claims, []);

      return {
        title: `⚖️ DMCA Processing ${vodId}`,
        description: `${part != null ? `Part ${part} — ` : ''}${claims.length} blocking claim${claims.length !== 1 ? 's' : ''} to process:\n\n${claimList}`,
        status: 'warning',
        fields: [
          { name: 'VOD ID', value: vodId, inline: true },
          { name: 'Platform', value: platform, inline: true },
          { name: 'Streamer', value: displayName, inline: true },
        ],
        timestamp: new Date().toISOString(),
      };
    },

    progress: (vodId, claims, completedClaimIds, currentStep, platform, displayName, stepProgress, currentCommand) => {
      const claimList = formatClaimList(claims, completedClaimIds, currentStep, stepProgress);
      const completed = completedClaimIds.length;
      const total = claims.length;

      const fields: Array<{ name: string; value: string; inline: boolean }> = [
        { name: 'VOD ID', value: vodId, inline: true },
        { name: 'Platform', value: platform, inline: true },
        { name: 'Streamer', value: displayName, inline: true },
      ];

      if (stepProgress != null && currentCommand != null) {
        const progressBar = createProgressBar(stepProgress);
        fields.push({ name: 'Progress', value: progressBar, inline: false });
        fields.push({ name: 'FFmpeg', value: `\`${currentCommand}\``, inline: false });
      }

      return {
        title: `⚖️ DMCA Processing ${vodId}`,
        description: `${completed}/${total} claims processed — ${currentStep}\n\n${claimList}`,
        status: 'warning',
        fields,
        timestamp: new Date().toISOString(),
        updatedTimestamp: new Date().toISOString(),
      };
    },

    complete: (vodId, youtubeJobId, claims, platform, displayName) => {
      const claimList = formatClaimList(
        claims,
        claims.map((c) => c.claimId ?? c.identifier)
      );

      return {
        title: `✅ DMCA Processing Complete`,
        description: `All ${claims.length} claims processed for ${vodId}:\n\n${claimList}`,
        status: 'success',
        fields: [
          { name: 'VOD ID', value: vodId, inline: true },
          { name: 'Platform', value: platform, inline: true },
          { name: 'Streamer', value: displayName, inline: true },
          { name: 'Upload Job ID', value: youtubeJobId, inline: false },
        ],
        timestamp: new Date().toISOString(),
      };
    },

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

// ============================================================================
// Copy Worker Alerts
// ============================================================================

export interface CopyWorkerAlerts {
  init: (vodId: string, sourcePath: string, destPath: string, fileSize: number) => RichEmbedData;
  progress: (
    vodId: string,
    percent: number,
    bytesCopied: number,
    totalBytes: number,
    speedBps: number,
    etaSeconds: number
  ) => RichEmbedData;
  complete: (vodId: string, destPath: string, fileSize: number, elapsedSeconds: number) => RichEmbedData;
  error: (vodId: string, bytesCopied: number, totalBytes: number, errorMsg: string) => RichEmbedData;
}

export function createCopyWorkerAlerts(): CopyWorkerAlerts {
  return {
    init: (vodId, sourcePath, destPath, fileSize) => ({
      title: `📋 Copying ${vodId}`,
      description: 'Copying file to tmpPath for processing',
      status: 'warning',
      fields: [
        { name: 'VOD ID', value: vodId, inline: true },
        { name: 'Size', value: formatBytes(fileSize), inline: true },
        { name: 'Source', value: sourcePath, inline: false },
        { name: 'Destination', value: destPath, inline: false },
      ],
      timestamp: new Date().toISOString(),
    }),

    progress: (vodId, percent, bytesCopied, totalBytes, speedBps, etaSeconds) => {
      const progressBar = createProgressBar(percent);

      return {
        title: `📋 Copying ${vodId}`,
        description: `Copying file to tmpPath for processing (${percent}%)`,
        status: 'warning',
        fields: [
          { name: 'VOD ID', value: vodId, inline: true },
          { name: 'Progress', value: progressBar, inline: false },
          { name: 'Copied', value: `${formatBytes(bytesCopied)} / ${formatBytes(totalBytes)}`, inline: false },
          { name: 'Speed', value: `${formatBytes(speedBps)}/s`, inline: true },
          { name: 'ETA', value: toHHMMSS(Math.max(0, etaSeconds)), inline: true },
        ],
        timestamp: new Date().toISOString(),
        updatedTimestamp: new Date().toISOString(),
      };
    },

    complete: (vodId, destPath, fileSize, elapsedSeconds) => {
      const avgSpeed = elapsedSeconds > 0 ? fileSize / elapsedSeconds : 0;

      return {
        title: `✅ Copy Complete ${vodId}`,
        description: 'File copy to tmpPath completed',
        status: 'success',
        fields: [
          { name: 'VOD ID', value: vodId, inline: true },
          { name: 'Size', value: formatBytes(fileSize), inline: true },
          { name: 'Time', value: toHHMMSS(elapsedSeconds), inline: true },
          { name: 'Avg Speed', value: `${formatBytes(avgSpeed)}/s`, inline: true },
          { name: 'Destination', value: destPath, inline: false },
        ],
        timestamp: new Date().toISOString(),
        updatedTimestamp: new Date().toISOString(),
      };
    },

    error: (vodId, bytesCopied, totalBytes, errorMsg) => ({
      title: `❌ Copy Failed ${vodId}`,
      description: 'File copy to tmpPath failed',
      status: 'error',
      fields: [
        { name: 'VOD ID', value: vodId, inline: true },
        { name: 'Copied', value: `${formatBytes(bytesCopied)} / ${formatBytes(totalBytes)}`, inline: true },
        { name: 'Error', value: errorMsg.substring(0, 500), inline: false },
      ],
      timestamp: new Date().toISOString(),
    }),
  };
}

// ============================================================================
// Finalize Worker Alerts
// ============================================================================

export interface FinalizeWorkerAlerts {
  init: (
    vodId: string,
    platform: Platform,
    sourceType: string,
    sourcePath: string,
    destPath: string,
    fileSize: number,
    saveMP4: boolean
  ) => RichEmbedData;
  progress: (
    vodId: string,
    percent: number,
    bytesCopied: number,
    totalBytes: number,
    speedBps: number,
    etaSeconds: number
  ) => RichEmbedData;
  complete: (
    vodId: string,
    platform: Platform,
    destPath: string,
    fileSize: number,
    elapsedSeconds: number,
    tmpDirCleaned: boolean
  ) => RichEmbedData;
  error: (vodId: string, platform: Platform, sourcePath: string, destPath: string, errorMsg: string) => RichEmbedData;
}

export function createFinalizeWorkerAlerts(): FinalizeWorkerAlerts {
  return {
    init: (vodId, platform, sourceType, sourcePath, destPath, fileSize, saveMP4) => ({
      title: `📦 Finalizing ${sourceType === SOURCE_TYPES.LIVE ? '[Live]' : '[VOD]'} ${vodId}`,
      description: saveMP4 ? 'Copying file to permanent storage' : 'Skipping MP4 save, cleaning up temp files',
      status: 'warning',
      fields: [
        { name: 'VOD ID', value: vodId, inline: true },
        { name: 'Platform', value: capitalizePlatform(platform), inline: true },
        { name: 'Type', value: sourceType === SOURCE_TYPES.LIVE ? 'Live' : 'VOD', inline: true },
        { name: 'Size', value: formatBytes(fileSize), inline: true },
        { name: 'Save MP4', value: saveMP4 ? 'Yes' : 'No', inline: true },
        { name: 'Source', value: sourcePath, inline: false },
        { name: 'Destination', value: destPath, inline: false },
      ],
      timestamp: new Date().toISOString(),
    }),

    progress: (vodId, percent, bytesCopied, totalBytes, speedBps, etaSeconds) => {
      const progressBar = createProgressBar(percent);

      return {
        title: `📦 Finalizing ${vodId}`,
        description: `Copying to permanent storage (${percent}%)`,
        status: 'warning',
        fields: [
          { name: 'VOD ID', value: vodId, inline: true },
          { name: 'Progress', value: progressBar, inline: false },
          { name: 'Copied', value: `${formatBytes(bytesCopied)} / ${formatBytes(totalBytes)}`, inline: false },
          { name: 'Speed', value: `${formatBytes(speedBps)}/s`, inline: true },
          { name: 'ETA', value: toHHMMSS(Math.max(0, etaSeconds)), inline: true },
        ],
        timestamp: new Date().toISOString(),
        updatedTimestamp: new Date().toISOString(),
      };
    },

    complete: (vodId, platform, destPath, fileSize, elapsedSeconds, tmpDirCleaned) => {
      const avgSpeed = elapsedSeconds > 0 ? fileSize / elapsedSeconds : 0;

      const fields: Array<{ name: string; value: string; inline: boolean }> = [
        { name: 'VOD ID', value: vodId, inline: true },
        { name: 'Platform', value: capitalizePlatform(platform), inline: true },
        { name: 'Size', value: formatBytes(fileSize), inline: true },
        { name: 'Time', value: toHHMMSS(elapsedSeconds), inline: true },
        { name: 'Avg Speed', value: `${formatBytes(avgSpeed)}/s`, inline: true },
        { name: 'Temp Cleaned', value: tmpDirCleaned ? 'Yes' : 'No', inline: true },
        { name: 'Destination', value: destPath, inline: false },
      ];

      return {
        title: `✅ Finalized ${vodId}`,
        description: 'File finalized to permanent storage',
        status: 'success',
        fields,
        timestamp: new Date().toISOString(),
        updatedTimestamp: new Date().toISOString(),
      };
    },

    error: (vodId, platform, sourcePath, destPath, errorMsg) => ({
      title: `❌ Finalization Failed ${vodId}`,
      description: 'Failed to finalize file',
      status: 'error',
      fields: [
        { name: 'VOD ID', value: vodId, inline: true },
        { name: 'Platform', value: capitalizePlatform(platform), inline: true },
        { name: 'Source', value: sourcePath, inline: false },
        { name: 'Destination', value: destPath, inline: false },
        { name: 'Error', value: errorMsg.substring(0, 500), inline: false },
      ],
      timestamp: new Date().toISOString(),
    }),
  };
}
