import { Job } from 'bullmq';
import { cleanupOrphanedTmpFiles } from './vod/hls-utils.js';
import { getDuration } from './utils/ffmpeg.js';
import { fileExists, getVodDirPath } from '../utils/path.js';
import { initRichAlert, updateAlert } from '../utils/discord-alerts.js';
import { extractErrorDetails } from '../utils/error.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { getJobContext } from './utils/job-context.js';
import { finalizeVod } from '../services/vod-finalization.js';
import { queueYoutubeUploads, type YoutubeUploadJobResult } from './jobs/youtube.job.js';
import { downloadHlsStream } from './vod/hls-orchestrator.js';
import { createLiveWorkerAlerts } from './utils/alert-factories.js';
import type { LiveDownloadJob } from './jobs/types.js';
import { triggerChatDownload } from './jobs/chat.job.js';
import { fetchAndSaveEmotes } from '../services/emotes.js';
import { SOURCE_TYPES } from '../types/platforms.js';
import { getDisplayName } from '../config/types.js';
import type { TenantConfig } from '../config/types.js';
import type { Kysely } from 'kysely';
import type { StreamerDB } from '../db/streamer-types.js';
import type { AppLogger } from '../utils/logger.js';
import type { Platform } from '../types/platforms.js';
import type { LiveWorkerAlerts } from './utils/alert-factories.js';

export interface LiveCompletionData {
  emotesSaved: boolean;
  chatJobId: string | null;
  youtubeVodJobId: string | null;
  youtubeGameJobIds: string[];
  segmentCount: number;
  finalPath: string;
}

export interface LiveDownloadResult {
  segmentCount: number;
  finalMp4Path: string;
}

export interface LiveProcessorContext {
  job: Job<LiveDownloadJob, unknown, string>;
  config: TenantConfig;
  db: Kysely<StreamerDB>;
  tenantId: string;
  log: AppLogger;
  alerts: LiveWorkerAlerts;
  messageId: string | null;
  dbId: number;
  vodId: string;
  platform: Platform;
  platformUserId: string;
  platformUsername?: string | undefined;
  startedAt?: string | undefined;
  sourceUrl?: string | undefined;
  streamerName: string;
}

export async function buildLiveProcessorContext(
  job: Job<LiveDownloadJob, unknown, string>
): Promise<LiveProcessorContext> {
  const { dbId, vodId, platform, tenantId, platformUserId, platformUsername, startedAt, sourceUrl } = job.data;
  const log = createAutoLogger(tenantId);

  log.info({ component: 'live-worker', jobId: job.id, dbId, vodId, platform, tenantId }, 'Starting job');
  await job.updateProgress(0);

  const ctx = await getJobContext(tenantId);
  const { config, db } = ctx;

  const streamerName = getDisplayName(config);
  const alerts = createLiveWorkerAlerts();

  const messageId = await initRichAlert(alerts.init(vodId, platform, streamerName, startedAt));

  return {
    job,
    config,
    db,
    tenantId,
    log,
    alerts,
    messageId,
    dbId,
    vodId,
    platform,
    platformUserId,
    platformUsername,
    startedAt,
    sourceUrl,
    streamerName,
  };
}

export async function prepareVodDirectory(ctx: LiveProcessorContext): Promise<void> {
  const vodDirPath = getVodDirPath({ config: ctx.config, vodId: ctx.vodId });
  if (await fileExists(vodDirPath)) {
    await cleanupOrphanedTmpFiles(vodDirPath, ctx.log);
  }
}

export async function runDownload(ctx: LiveProcessorContext): Promise<LiveDownloadResult> {
  const downloadResult = await downloadHlsStream({
    ctx,
    dbId: ctx.dbId,
    vodId: ctx.vodId,
    platform: ctx.platform,
    platformUserId: ctx.platformUserId,
    platformUsername: ctx.platformUsername,
    startedAt: ctx.startedAt,
    sourceUrl: ctx.sourceUrl,
    isLive: true,
    discordMessageId: ctx.messageId ?? undefined,
    streamerName: ctx.streamerName,
    onProgress: (segmentsDownloaded) => {
      void updateAlert(ctx.messageId, ctx.alerts.progress(ctx.vodId, segmentsDownloaded)).catch((err) => {
        ctx.log.warn({ err: extractErrorDetails(err), vodId: ctx.vodId }, 'Discord alert update failed (non-critical)');
      });
    },
  });

  await ctx.job.updateProgress(50);
  await updateAlert(ctx.messageId, ctx.alerts.converting(ctx.vodId, downloadResult.segmentCount));

  return {
    segmentCount: downloadResult.segmentCount,
    finalMp4Path: downloadResult.finalMp4Path,
  };
}

export async function runFinalization(
  ctx: LiveProcessorContext,
  downloadResult: LiveDownloadResult
): Promise<number | null> {
  const actualDuration = await getDuration(downloadResult.finalMp4Path);
  await finalizeVod({
    ctx,
    dbId: ctx.dbId,
    vodId: ctx.vodId,
    platform: ctx.platform,
    durationSeconds: actualDuration != null ? Math.round(actualDuration) : null,
  });
  return actualDuration;
}

export async function runPostProcessing(
  ctx: LiveProcessorContext,
  downloadResult: LiveDownloadResult,
  actualDuration: number | null
): Promise<LiveCompletionData> {
  let emotesSaved = false;
  let chatJobId: string | null = null;
  let youtubeResult: YoutubeUploadJobResult = { vodJobId: null, gameJobIds: [] };

  // 4. Save Emotes (non-fatal)
  try {
    await fetchAndSaveEmotes(ctx, ctx.dbId, ctx.platform, ctx.platformUserId);
    emotesSaved = true;
    await updateAlert(ctx.messageId, ctx.alerts.emotesSaved(ctx.vodId));
    ctx.log.info({ vodId: ctx.vodId }, 'Queued emote save');
  } catch (error) {
    ctx.log.warn({ ...extractErrorDetails(error), vodId: ctx.vodId }, 'Failed to save emotes (non-fatal)');
  }

  // 5. Queue chat download (non-fatal)
  try {
    chatJobId = await triggerChatDownload(
      ctx.tenantId,
      ctx.platformUserId,
      ctx.dbId,
      ctx.vodId,
      ctx.platform,
      actualDuration != null ? Math.round(actualDuration) : 0,
      ctx.platformUsername
    );
    if (chatJobId != null) {
      await updateAlert(ctx.messageId, ctx.alerts.chatQueued(ctx.vodId));
    }
    ctx.log.info({ vodId: ctx.vodId, chatJobId }, 'Queued chat download job');
  } catch (error) {
    ctx.log.warn({ ...extractErrorDetails(error), vodId: ctx.vodId }, 'Failed to queue chat download (non-fatal)');
  }

  // 6. Queue upload (non-fatal)
  try {
    youtubeResult = await queueYoutubeUploads({
      ctx,
      dbId: ctx.dbId,
      vodId: ctx.vodId,
      filePath: downloadResult.finalMp4Path,
      platform: ctx.platform,
      type: SOURCE_TYPES.VOD,
    });
    if (youtubeResult.vodJobId != null || youtubeResult.gameJobIds.length > 0) {
      await updateAlert(ctx.messageId, ctx.alerts.uploadQueued(ctx.vodId));
    }
  } catch (error) {
    ctx.log.warn({ ...extractErrorDetails(error), vodId: ctx.vodId }, 'Failed to queue upload (non-fatal)');
  }

  return {
    emotesSaved,
    chatJobId,
    youtubeVodJobId: youtubeResult.vodJobId,
    youtubeGameJobIds: youtubeResult.gameJobIds,
    segmentCount: downloadResult.segmentCount,
    finalPath: downloadResult.finalMp4Path,
  };
}

export async function sendCompletionAlert(
  ctx: LiveProcessorContext,
  completionData: LiveCompletionData,
  actualDuration: number | null
): Promise<void> {
  await ctx.job.updateProgress(100);
  await updateAlert(
    ctx.messageId,
    ctx.alerts.complete(ctx.vodId, actualDuration != null ? Math.round(actualDuration) : undefined, completionData)
  );
  ctx.log.info({ component: 'live-worker', jobId: ctx.job.id, vodId: ctx.vodId }, 'Job completed successfully');
}
