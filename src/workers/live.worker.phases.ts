import type { Job } from 'bullmq';
import { getDisplayName } from '../config/types.ts';
import { fetchAndSaveEmotes } from '../services/emotes.ts';
import { finalizeVod } from '../services/vod-finalization.ts';
import { SOURCE_TYPES } from '../types/platforms.ts';
import { createAutoLogger } from '../utils/auto-tenant-logger.ts';
import { initRichAlert, updateAlert } from '../utils/discord-alerts.ts';
import { extractErrorDetails } from '../utils/error.ts';
import { fileExists, getTmpDirPath } from '../utils/path.ts';
import { triggerChatDownload } from './jobs/chat.job.ts';
import type { LiveDownloadJob } from './jobs/types.ts';
import { enqueueFinalizeJob, queueYoutubeUploads, type YoutubeUploadJobResult } from './jobs/youtube.job.ts';
import type { BaseWorkerContext, LiveCompletionData } from './types.ts';
import type { LiveWorkerAlerts } from './utils/alert-factories.ts';
import { createLiveWorkerAlerts, safeUpdateAlert } from './utils/alert-factories.ts';
import { getMetadata } from './utils/ffmpeg.ts';
import { getJobContext } from './utils/job-context.ts';
import { downloadHlsStream } from './vod/hls-orchestrator.ts';
import { cleanupOrphanedTmpFiles } from './vod/hls-utils.ts';

export interface LivePhaseResult {
  segmentCount: number;
  finalMp4Path: string;
}

export interface LiveProcessorContext extends BaseWorkerContext {
  job: Job<LiveDownloadJob, unknown, string>;
  alerts: LiveWorkerAlerts;
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

  const { config, db } = await getJobContext(tenantId);
  const log = createAutoLogger(String(tenantId));

  log.info({ component: 'worker', jobId: job.id, dbId, vodId, platform, tenantId }, 'Starting job');
  await job.updateProgress(0);

  const streamerName = getDisplayName(config);
  const alerts = createLiveWorkerAlerts();
  const messageId = await initRichAlert(alerts.init(vodId, platform, streamerName, startedAt)).catch(() => null);

  return {
    config,
    db,
    tenantId,
    log,
    dbId,
    vodId,
    platform,
    platformUserId,
    platformUsername,
    startedAt,
    sourceUrl,
    job,
    streamerName,
    alerts,
    messageId,
  };
}

export async function prepareVodDirectory(ctx: LiveProcessorContext): Promise<void> {
  const vodDirPath = getTmpDirPath({ tenantId: ctx.tenantId, vodId: ctx.vodId });
  if (await fileExists(vodDirPath)) {
    await cleanupOrphanedTmpFiles(vodDirPath, ctx.log);
  }
}

export async function runDownload(ctx: LiveProcessorContext): Promise<LivePhaseResult> {
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
    onProgress: (segmentsDownloaded, duration) => {
      void ctx.job.updateProgress(segmentsDownloaded).catch(() => {});
      safeUpdateAlert(
        ctx.messageId,
        ctx.alerts.progress(ctx.vodId, ctx.platform, ctx.streamerName, segmentsDownloaded, duration),
        ctx.log,
        ctx.vodId
      );
    },
  });

  await ctx.job.updateProgress(50);

  return {
    segmentCount: downloadResult.segmentCount,
    finalMp4Path: downloadResult.finalMp4Path,
  };
}

export async function runFinalization(
  ctx: LiveProcessorContext,
  downloadResult: LivePhaseResult
): Promise<number | null> {
  const actualDuration = (await getMetadata(downloadResult.finalMp4Path))?.duration ?? null;
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
  downloadResult: LivePhaseResult,
  actualDuration: number | null
): Promise<LiveCompletionData> {
  let emotesSaved = false;
  let chatJobId: string | null = null;
  let youtubeResult: YoutubeUploadJobResult = { vodJobId: null, gameJobIds: [] };

  // 4. Save Emotes (non-fatal)
  try {
    await fetchAndSaveEmotes(ctx, ctx.dbId);
    emotesSaved = true;
    await updateAlert(ctx.messageId, ctx.alerts.emotesSaved(ctx.vodId, ctx.streamerName));
    ctx.log.info({ vodId: ctx.vodId }, 'Queued emote save');
  } catch (error) {
    ctx.log.warn({ ...extractErrorDetails(error), vodId: ctx.vodId }, 'Failed to save emotes (non-fatal)');
  }

  // 5. Queue chat download (non-fatal)
  try {
    chatJobId = await triggerChatDownload({
      tenantId: ctx.tenantId,
      displayName: ctx.streamerName,
      platformUserId: ctx.platformUserId,
      dbId: ctx.dbId,
      vodId: ctx.vodId,
      platform: ctx.platform,
      duration: actualDuration != null ? Math.round(actualDuration) : 0,
      platformUsername: ctx.platformUsername,
    });
    if (chatJobId != null) {
      await updateAlert(ctx.messageId, ctx.alerts.chatQueued(ctx.vodId, ctx.streamerName));
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
      workDir: getTmpDirPath({ tenantId: ctx.tenantId, vodId: ctx.vodId }),
    });
    if (youtubeResult.vodJobId != null || youtubeResult.gameJobIds.length > 0) {
      await updateAlert(ctx.messageId, ctx.alerts.uploadQueued(ctx.vodId, ctx.streamerName));
    }
  } catch (error) {
    ctx.log.warn({ ...extractErrorDetails(error), vodId: ctx.vodId }, 'Failed to queue upload (non-fatal)');
  }

  // YouTube disabled -- enqueue finalize job ourselves
  const uploadEnabled = ctx.config.youtube?.upload === true;
  const vodUploadEnabled = ctx.config.youtube?.vodUpload === true;
  const perGameUploadEnabled = ctx.config.youtube?.perGameUpload === true;
  if (!uploadEnabled || (!vodUploadEnabled && !perGameUploadEnabled)) {
    try {
      await enqueueFinalizeJob(ctx, ctx.dbId, ctx.vodId, downloadResult.finalMp4Path, SOURCE_TYPES.VOD, ctx.platform, {
        workDir: getTmpDirPath({ tenantId: ctx.tenantId, vodId: ctx.vodId }),
        saveMP4: ctx.config.settings.saveMP4,
        saveHLS: ctx.config.settings.saveHLS,
      });
    } catch (err) {
      ctx.log.warn({ err: extractErrorDetails(err), vodId: ctx.vodId }, 'Failed to enqueue finalize job');
    }
  }

  return {
    emotesSaved,
    chatJobId,
    youtubeVodJobId: youtubeResult.vodJobId,
    youtubeGameJobIds: youtubeResult.gameJobIds,
    segmentCount: downloadResult.segmentCount,
    finalPath: downloadResult.finalMp4Path,
    streamerName: ctx.streamerName,
    platform: ctx.platform,
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
