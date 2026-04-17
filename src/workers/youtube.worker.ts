import { Processor, Job } from 'bullmq';
import type { YoutubeUploadJob, YoutubeUploadResult, YoutubeVodUploadJob, YoutubeGameUploadJob, YoutubeUploadVodResult } from './jobs/queues.js';
import { getJobContext } from './utils/job-context.js';
import { handleWorkerError } from './utils/error-handler.js';
import { processVodUpload, linkVodPartsAfterDelay } from './youtube/vod-upload-processor.js';
import { getEffectiveSplitDuration } from './youtube/validation.js';
import { processGameUpload } from './youtube/game-upload-processor.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import type { AppLogger } from '../utils/logger.js';
import { resetFailures } from '../utils/discord-alerts.js';
import { PLATFORMS, UPLOAD_TYPES } from '../types/platforms.js';
import { TenantConfig } from '../config/types.js';
import { PrismaClient } from '../../generated/streamer/client.js';

const youtubeProcessor: Processor<YoutubeUploadJob, YoutubeUploadResult> = async (job: Job<YoutubeUploadJob>) => {
  const { tenantId, dbId, vodId, type, filePath } = job.data;

  const log = createAutoLogger(String(tenantId));
  const startTime = Date.now();
  const jobId = job.id;

  let actualFilePath = filePath;

  if (!actualFilePath) {
    const childResults = await job.getChildrenValues();
    const downloadResult = Object.values(childResults)[0] as { finalPath?: string };

    if (!downloadResult?.finalPath) {
      throw new Error(`File path not available for vodId=${vodId}, jobId=${jobId}: download job may have failed or not completed`);
    }

    actualFilePath = downloadResult.finalPath;
    log.debug({ vodId, filePath: actualFilePath, jobId }, 'Retrieved filePath from download job result');
  }

  const { config, db } = await getJobContext(tenantId);

  if (!config || !config.youtube) {
    throw new Error(`YouTube not configured for tenant ${tenantId}`);
  }

  let fileSize: number | undefined;
  try {
    const fs = await import('fs');
    const stats = fs.statSync(actualFilePath);
    fileSize = stats.size;
  } catch {
    log.warn({ vodId, filePath: actualFilePath }, 'Could not get file size');
  }

  const state = await job.getState();
  log.info({ vodId, jobId, type, part: (job.data as YoutubeVodUploadJob).part, fileSize, filePath: actualFilePath, state, attemptsMade: job.attemptsMade }, '[youtube-upload] Job started');

  try {
    if (type === UPLOAD_TYPES.VOD) {
      const vodResult = await processVodUploadJob({ ...job.data, filePath: actualFilePath } as YoutubeVodUploadJob & { filePath: string }, config, db, log);
      const duration = Date.now() - startTime;
      log.info({ vodId, jobId, duration, uploadedVideosCount: (vodResult as YoutubeUploadVodResult).videos?.length }, '[youtube-upload] Job completed successfully');
      return vodResult;
    } else {
      const result = await processGameUploadJob({ ...job.data, filePath: actualFilePath } as YoutubeGameUploadJob & { filePath: string }, config, db, log);
      const duration = Date.now() - startTime;
      log.info({ vodId, jobId, duration }, '[youtube-upload] Game upload completed successfully');
      return result;
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    const stateAtFailure = await job.getState();

    const errorMsg = handleWorkerError(error, log, {
      vodId,
      tenantId,
      dbId,
      jobId,
      duration,
      stateAtFailure,
      attemptsMade: job.attemptsMade,
      filePath: actualFilePath,
    });

    await db.vodUpload.updateMany({
      where: { vod_id: dbId },
      data: { status: 'FAILED' },
    });

    log.error({ vodId, jobId, duration, stateAtFailure, errorMsg }, '[youtube-upload] Job failed');

    throw error;
  }
};

async function processVodUploadJob(job: YoutubeVodUploadJob & { filePath: string }, config: TenantConfig, db: PrismaClient, log: AppLogger): Promise<YoutubeUploadResult> {
  const { tenantId, dbId, vodId, filePath, dmcaProcessed, vodRecord, part } = job;

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
    part,
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

  const splitDuration = getEffectiveSplitDuration(config.youtube!.splitDuration);
  await linkVodPartsAfterDelay(tenantId, dbId, result.uploadedVideos, splitDuration, db);

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
