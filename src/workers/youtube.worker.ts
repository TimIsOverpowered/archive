import { Processor, Job } from 'bullmq';
import type { YoutubeUploadJob, YoutubeUploadResult, YoutubeVodUploadJob, YoutubeGameUploadJob } from './jobs/queues.js';
import { getJobContext } from './job-context.js';
import { handleWorkerError } from './utils/error-handler.js';
import { processVodUpload, linkVodPartsAfterDelay } from './youtube/vod-upload-processor.js';
import { processGameUpload } from './youtube/game-upload-processor.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { resetFailures } from '../utils/discord-alerts.js';

const youtubeProcessor: Processor<YoutubeUploadJob, YoutubeUploadResult> = async (job: Job<YoutubeUploadJob>) => {
  const { tenantId, dbId, vodId, type } = job.data;

  const log = createAutoLogger(String(tenantId));
  const { config, db } = await getJobContext(tenantId);

  if (!config || !config.youtube) {
    throw new Error(`YouTube not configured for tenant ${tenantId}`);
  }

  try {
    if (type === 'vod') {
      return await processVodUploadJob(job.data, config, db, log);
    } else {
      return await processGameUploadJob(job.data, config, db, log);
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

async function processVodUploadJob(
  job: YoutubeVodUploadJob,
  config: NonNullable<Awaited<ReturnType<typeof getJobContext>>['config']>,
  db: Awaited<ReturnType<typeof getJobContext>>['db'],
  log: ReturnType<typeof createAutoLogger>
): Promise<YoutubeUploadResult> {
  const { tenantId, dbId, vodId, filePath, dmcaProcessed } = job;

  const vodRecord = await db.vod.findUnique({ where: { id: dbId } });
  if (!vodRecord) throw new Error(`VOD record not found for ${vodId}`);

  const result = await processVodUpload({
    tenantId,
    dbId,
    vodId,
    filePath,
    db,
    config,
    vodRecord: {
      platform: vodRecord.platform,
      created_at: vodRecord.created_at,
      title: vodRecord.title,
    },
    dmcaProcessed,
    log,
    type: 'vod',
  });

  for (const video of result.uploadedVideos) {
    await db.vodUpload.create({
      data: {
        vod_id: dbId,
        upload_id: video.id,
        type: 'vod',
        part: video.part,
        status: 'COMPLETED',
      },
    });
  }

  await linkVodPartsAfterDelay(tenantId, result.uploadedVideos);

  return { success: true, videos: result.uploadedVideos };
}

async function processGameUploadJob(
  job: YoutubeGameUploadJob,
  config: NonNullable<Awaited<ReturnType<typeof getJobContext>>['config']>,
  db: Awaited<ReturnType<typeof getJobContext>>['db'],
  log: ReturnType<typeof createAutoLogger>
): Promise<YoutubeUploadResult> {
  const { tenantId, dbId, vodId, filePath, platform, chapterName, chapterStart, chapterEnd, chapterGameId, title, description } = job;

  const hasTwitch = config.twitch?.enabled === true;
  const hasKick = config.kick?.enabled === true;

  if (hasTwitch && hasKick) {
    const isMainPlatform = platform === 'twitch' ? config.twitch?.mainPlatform : config.kick?.mainPlatform;

    if (!isMainPlatform) {
      log.info(`[${vodId}] Skipping game upload: ${platform} is not main platform (simulcast mode)`);

      await db.game.updateMany({
        where: { vod_id: dbId },
        data: { video_provider: null, video_id: null, thumbnail_url: null },
      });

      resetFailures(tenantId);
      return { success: true, videoId: '', gameId: '' };
    }
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
