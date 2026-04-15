import { Processor, Job } from 'bullmq';
import type { YoutubeUploadJob, YoutubeUploadResult, YoutubeVodUploadJob, YoutubeGameUploadJob } from './jobs/queues.js';
import { getJobContext } from './utils/job-context.js';
import { handleWorkerError } from './utils/error-handler.js';
import { processVodUpload, linkVodPartsAfterDelay } from './youtube/vod-upload-processor.js';
import { processGameUpload } from './youtube/game-upload-processor.js';
import { AppLogger, createAutoLogger } from '../utils/auto-tenant-logger.js';
import { resetFailures } from '../utils/discord-alerts.js';
import { PLATFORMS, UPLOAD_TYPES } from '../types/platforms.js';
import { TenantConfig } from '../config/types.js';
import { PrismaClient } from '../../generated/streamer/client.js';

const youtubeProcessor: Processor<YoutubeUploadJob, YoutubeUploadResult> = async (job: Job<YoutubeUploadJob>) => {
  const { tenantId, dbId, vodId, type } = job.data;
  let filePath = job.data.filePath;

  const log = createAutoLogger(String(tenantId));

  // If filePath is not set, try to get it from the download job result (FlowProducer child)
  if (!filePath) {
    const childResults = await job.getChildrenValues();
    const downloadResult = Object.values(childResults)[0] as { finalPath?: string };

    if (!downloadResult?.finalPath) {
      throw new Error(`File path not available for vodId=${vodId}, jobId=${job.id}: download job may have failed or not completed`);
    }

    filePath = downloadResult.finalPath;
    job.data.filePath = filePath;
    log.debug({ vodId, filePath, jobId: job.id }, 'Retrieved filePath from download job result');
  }

  const { config, db } = await getJobContext(tenantId);

  if (!config || !config.youtube) {
    throw new Error(`YouTube not configured for tenant ${tenantId}`);
  }

  try {
    if (type === UPLOAD_TYPES.VOD) {
      return await processVodUploadJob({ ...job.data, filePath: filePath! } as YoutubeVodUploadJob & { filePath: string }, config, db, log);
    } else {
      return await processGameUploadJob({ ...job.data, filePath: filePath! } as YoutubeGameUploadJob & { filePath: string }, config, db, log);
    }
  } catch (error) {
    const errorMsg = handleWorkerError(error, log, { vodId, tenantId, dbId, jobId: job.id });

    await db.vodUpload.updateMany({
      where: { vod_id: dbId },
      data: { status: 'FAILED' },
    });

    log.warn({ vodId, errorMsg }, 'YouTube upload job failed');

    throw error;
  }
};

async function processVodUploadJob(job: YoutubeVodUploadJob & { filePath: string }, config: TenantConfig, db: PrismaClient, log: AppLogger): Promise<YoutubeUploadResult> {
  const { tenantId, dbId, vodId, filePath, dmcaProcessed, vodRecord } = job;

  const result = await processVodUpload({
    tenantId,
    dbId,
    vodId,
    filePath,
    db,
    config,
    vodRecord,
    dmcaProcessed,
    log,
    type: UPLOAD_TYPES.VOD,
  });

  for (const video of result.uploadedVideos) {
    await db.vodUpload.create({
      data: {
        vod_id: dbId,
        upload_id: video.id,
        type: UPLOAD_TYPES.VOD,
        part: video.part,
        status: 'COMPLETED',
      },
    });
  }

  await linkVodPartsAfterDelay(tenantId, result.uploadedVideos);

  return { success: true, videos: result.uploadedVideos };
}

async function processGameUploadJob(job: YoutubeGameUploadJob & { filePath: string }, config: TenantConfig, db: PrismaClient, log: AppLogger): Promise<YoutubeUploadResult> {
  const { tenantId, dbId, vodId, filePath, platform, chapterName, chapterStart, chapterEnd, chapterGameId, title, description } = job;

  if (platform === PLATFORMS.TWITCH && !config.twitch?.mainPlatform) {
    resetFailures(tenantId);
    return { success: true, videoId: '', gameId: '' };
  }

  if (platform === PLATFORMS.KICK && !config.kick?.mainPlatform) {
    resetFailures(tenantId);
    return { success: true, videoId: '', gameId: '' };
  }

  const result = await processGameUpload({
    tenantId,
    dbId,
    vodId,
    filePath,
    chapterStart,
    chapterEnd,
    chapterName,
    chapterGameId,
    title,
    description,
    db,
    config,
    log,
  });

  resetFailures(tenantId);
  return result as YoutubeUploadResult;
}

export default youtubeProcessor;
