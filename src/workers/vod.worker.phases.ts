import { Job } from 'bullmq';
import { cleanupOrphanedTmpFiles } from './vod/hls-utils.js';
import { getVodFilePath, getVodDirPath, fileExists } from '../utils/path.js';
import { initRichAlert, updateAlert } from '../utils/discord-alerts.js';
import { extractErrorDetails } from '../utils/error.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { getJobContext } from './utils/job-context.js';
import { createVodWorkerAlerts } from './utils/alert-factories.js';
import type { StandardVodJob } from './jobs/types.js';
import { downloadVodWithFfmpeg } from './vod/vod-download-strategies.js';
import { DOWNLOAD_METHODS, PLATFORMS, type DownloadMethod, type Platform } from '../types/platforms.js';
import { downloadHlsStream } from './vod/hls-orchestrator.js';
import { getDisplayName } from '../config/types.js';
import { PlatformNotConfiguredError } from '../utils/domain-errors.js';
import type { TenantConfig } from '../config/types.js';
import type { Kysely } from 'kysely';
import type { StreamerDB } from '../db/streamer-types.js';
import type { VodWorkerAlerts } from './utils/alert-factories.js';
import type { AppLogger } from '../utils/logger.js';

export interface VodProcessorContext {
  job: Job<StandardVodJob, unknown, string>;
  config: TenantConfig;
  db: Kysely<StreamerDB>;
  tenantId: string;
  log: AppLogger;
  alerts: VodWorkerAlerts;
  messageId: string | null;
  dbId: number;
  vodId: string;
  platform: Platform;
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
  const log = createAutoLogger(tenantId);

  log.info({ component: 'vod-worker', jobId: job.id, dbId, vodId, platform, tenantId }, 'Starting job');
  await job.updateProgress(0);

  const ctx = await getJobContext(tenantId);
  const { config, db } = ctx;

  const finalPath = getVodFilePath({ config, vodId });
  const streamerName = getDisplayName(config);
  const alerts = createVodWorkerAlerts();

  const messageId = await initRichAlert(alerts.init(vodId, platform, streamerName));

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
    sourceUrl,
    streamerName,
    downloadMethod,
    finalPath,
  };
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
      throw new Error('Kick source URL not available for VOD');
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
        void updateAlert(ctx.messageId, ctx.alerts.progress(ctx.vodId, segmentsDownloaded, totalSegments)).catch(
          (err) => {
            ctx.log.warn(
              { err: extractErrorDetails(err), vodId: ctx.vodId },
              'Discord alert update failed (non-critical)'
            );
          }
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
