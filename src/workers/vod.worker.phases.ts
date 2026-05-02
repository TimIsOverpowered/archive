import { Job } from 'bullmq';
import { cleanupOrphanedTmpFiles } from './vod/hls-utils.js';
import { getVodFilePath, getVodDirPath, fileExists } from '../utils/path.js';
import { updateAlert } from '../utils/discord-alerts.js';
import { extractErrorDetails } from '../utils/error.js';
import { createVodWorkerAlerts, safeUpdateAlert } from './utils/alert-factories.js';
import type { StandardVodJob } from './jobs/types.js';
import { downloadVodWithFfmpeg } from './vod/vod-download-strategies.js';
import { DOWNLOAD_METHODS, PLATFORMS, type DownloadMethod } from '../types/platforms.js';
import { downloadHlsStream } from './vod/hls-orchestrator.js';
import { getDisplayName } from '../config/types.js';
import { PlatformNotConfiguredError } from '../utils/domain-errors.js';
import { getStrategy } from '../services/platforms/strategy.js';
import type { VodWorkerAlerts } from './utils/alert-factories.js';
import type { BaseWorkerContext } from './types.js';
import { buildWorkerContext } from './utils/job-context.js';

export interface VodProcessorContext extends BaseWorkerContext {
  job: Job<StandardVodJob, unknown, string>;
  alerts: VodWorkerAlerts;
  platformUserId: string;
  platformUsername?: string;
  sourceUrl?: string | undefined;
  streamerName: string;
  downloadMethod: DownloadMethod;
  finalPath: string;
}

export async function buildVodProcessorContext(
  job: Job<StandardVodJob, unknown, string>
): Promise<VodProcessorContext> {
  const {
    dbId,
    vodId,
    platform,
    tenantId,
    downloadMethod = DOWNLOAD_METHODS.HLS,
    platformUserId,
    platformUsername,
    sourceUrl,
  } = job.data;

  return buildWorkerContext<
    VodProcessorContext,
    {
      platformUserId: string;
      platformUsername: string | undefined;
      sourceUrl: string | undefined;
      downloadMethod: DownloadMethod;
      job: Job<StandardVodJob, unknown, string>;
      streamerName: string;
      finalPath: string;
    }
  >(
    job,
    tenantId,
    dbId,
    vodId,
    platform,
    (config) => {
      const streamerName = getDisplayName(config);
      const finalPath = getVodFilePath({ config, vodId });
      return {
        extra: { platformUserId, platformUsername, sourceUrl, downloadMethod, job, streamerName, finalPath },
        alertInitArgs: [vodId, platform, streamerName],
      };
    },
    createVodWorkerAlerts
  );
}

export async function runVodDownload(ctx: VodProcessorContext): Promise<void> {
  if (ctx.downloadMethod === DOWNLOAD_METHODS.FFMPEG) {
    await downloadVodWithFfmpeg(ctx.platform, ctx.vodId, ctx.finalPath, ctx.config, ctx.log);
  } else {
    const vodDirPath = getVodDirPath({ config: ctx.config, vodId: ctx.vodId });
    if (await fileExists(vodDirPath)) {
      await cleanupOrphanedTmpFiles(vodDirPath, ctx.log);
    }

    if (ctx.platformUserId == null) {
      throw new PlatformNotConfiguredError(ctx.platform, `user ID missing for ${ctx.job.id}`);
    }

    if (ctx.platform === PLATFORMS.KICK && ctx.sourceUrl == null) {
      const username = ctx.platformUsername;
      if (username == null) {
        throw new Error('Kick source URL not available for VOD: platformUsername is missing');
      }
      try {
        const strategy = getStrategy(ctx.platform);
        if (!strategy) {
          throw new Error(`No strategy registered for platform ${ctx.platform}`);
        }
        const vodMetadata = await strategy.fetchVodMetadata(ctx.vodId, {
          config: ctx.config,
          platform: ctx.platform,
          tenantId: ctx.tenantId,
        });
        if (!vodMetadata) {
          throw new Error(`VOD ${ctx.vodId} not found on ${ctx.platform}`);
        }
        ctx.sourceUrl = vodMetadata.sourceUrl ?? undefined;
      } catch (err) {
        ctx.log.warn({ err: extractErrorDetails(err), vodId: ctx.vodId }, 'Failed to fetch Kick VOD source URL');
      }
      if (ctx.sourceUrl == null) {
        throw new Error('Kick source URL not available for VOD');
      }
      ctx.log.info({ vodId: ctx.vodId }, 'Fetched Kick source URL from API');
    }

    await downloadHlsStream({
      ctx,
      dbId: ctx.dbId,
      vodId: ctx.vodId,
      platform: ctx.platform,
      platformUserId: ctx.platformUserId,
      platformUsername: ctx.platformUsername,
      sourceUrl: ctx.sourceUrl,
      isLive: false,
      discordMessageId: ctx.messageId ?? undefined,
      streamerName: ctx.streamerName,
      onProgress: (segmentsDownloaded, totalSegments) => {
        const percent = totalSegments > 0 ? Math.round((segmentsDownloaded / totalSegments) * 100) : 0;
        void ctx.job.updateProgress(percent).catch(() => {});
        safeUpdateAlert(
          ctx.messageId,
          ctx.alerts.progress(ctx.vodId, segmentsDownloaded, totalSegments),
          ctx.log,
          ctx.vodId
        );
      },
    });

    ctx.log.info({ vodId: ctx.vodId, platform: ctx.platform }, `Downloaded ${ctx.vodId}.mp4`);
  }
}

export async function sendVodCompletion(ctx: VodProcessorContext): Promise<void> {
  await ctx.job.updateProgress(100);
  await updateAlert(ctx.messageId, ctx.alerts.complete(ctx.vodId, ctx.platform, ctx.finalPath));

  ctx.log.info(
    {
      component: 'vod-worker',
      jobId: ctx.job.id,
      dbId: ctx.dbId,
      vodId: ctx.vodId,
      platform: ctx.platform,
      tenantId: ctx.tenantId,
    },
    'Job completed successfully'
  );
}
