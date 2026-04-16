import { flowProducer, getStandardVodQueue, getYoutubeUploadQueue } from './queues.js';
import type { YoutubeVodUploadJob, YoutubeGameUploadJob } from './queues.js';
import dayjs from '../../utils/dayjs.js';
import { childLogger } from '../../utils/logger.js';
import type { Platform, UploadMode } from '../../types/platforms.js';
import { UPLOAD_TYPES, UPLOAD_MODES } from '../../types/platforms.js';
import { TenantContext } from '../../types/context.js';
import { withDbRetry } from '../../db/client.js';

const log = childLogger({ module: 'youtube-job' });

// ============== VOD Job Creation ==============

export async function createVodUploadJob(ctx: TenantContext, dbId: number, vodId: string, filePath: string | undefined, platform: Platform, part?: number): Promise<YoutubeVodUploadJob> {
  const { config, tenantId } = ctx;
  if (!config?.youtube?.upload) {
    throw new Error(`YouTube upload not enabled for tenant ${tenantId}`);
  }

  const vodRecord = await withDbRetry(ctx.tenantId, ctx.config, async (db) => {
    return db.vod.findUnique({ where: { id: dbId } });
  });

  if (!vodRecord) {
    throw new Error(`VOD record not found for dbId ${dbId}`);
  }

  return {
    tenantId,
    dbId,
    vodId,
    filePath,
    type: UPLOAD_TYPES.VOD,
    vodRecord: vodRecord,
    platform,
    part: part ?? 1,
  };
}

// ============== Game Job Creation ==============

export async function createGameUploadJob(
  ctx: TenantContext,
  dbId: number,
  vodId: string,
  filePath: string | undefined,
  platform: Platform,
  chapter: { id: number; name: string; start: number; end: number; gameId?: string }
): Promise<YoutubeGameUploadJob> {
  const { config, tenantId } = ctx;
  if (!config?.youtube?.upload) {
    throw new Error(`YouTube upload not enabled for tenant ${tenantId}`);
  }

  const vodRecord = await withDbRetry(ctx.tenantId, ctx.config, async (db) => {
    return db.vod.findUnique({ where: { id: dbId } });
  });

  if (!vodRecord) {
    throw new Error(`VOD record not found for dbId ${dbId}`);
  }

  // Check restricted games
  if (config.youtube.restrictedGames.includes(chapter.name || '')) {
    throw new Error(`Game "${chapter.name}" is in restricted games list`);
  }

  // Calculate EP number (global count across all VODs)
  const gameCount = await withDbRetry(ctx.tenantId, ctx.config, async (db) => {
    return db.game.count({
      where: {
        game_name: chapter.name,
        vod_id: { not: dbId },
      },
    });
  });
  const epNumber = gameCount + 1;

  const channelName = config.displayName || tenantId;
  const dateFormatted = dayjs(vodRecord.created_at)
    .tz(config.settings?.timezone || 'UTC')
    .format('MMMM DD YYYY')
    .toUpperCase();

  const vodStreamTitle = vodRecord.title ? vodRecord.title.replace(/>|</gi, '') : '';
  const domainName = config.settings?.domainName || 'localhost';

  // Generate title with EP number
  const title = `${channelName} plays ${chapter.name} EP ${epNumber} - ${dateFormatted}`;

  // Generate description
  const description = `Chat Replay: https://${domainName}/games/${vodId}\nStream Title: ${vodStreamTitle}\n${config.youtube.description || ''}`;

  return {
    tenantId,
    dbId,
    vodId,
    filePath,
    type: 'game',
    platform,
    chapterId: chapter.id,
    chapterName: chapter.name,
    chapterStart: chapter.start,
    chapterEnd: chapter.end,
    chapterGameId: chapter.gameId,
    title,
    description,
  };
}

// ============== Bulk Game Job Creation ==============

export async function createGameUploadJobsForVod(ctx: TenantContext, dbId: number, vodId: string, filePath: string | undefined, platform: Platform): Promise<YoutubeGameUploadJob[]> {
  const { config, tenantId } = ctx;
  if (!config?.youtube?.perGameUpload) {
    return [];
  }

  // Fetch all chapters for this VOD
  const chapters = await withDbRetry(ctx.tenantId, ctx.config, async (db) => {
    return db.chapter.findMany({
      where: { vod_id: dbId },
      orderBy: { start: 'asc' },
    });
  });

  const jobs: YoutubeGameUploadJob[] = [];

  for (const chapter of chapters) {
    try {
      const job = await createGameUploadJob(ctx, dbId, vodId, filePath, platform, {
        id: chapter.id,
        name: chapter.name || '',
        start: chapter.start ?? 0,
        end: chapter.end ?? 0,
        gameId: chapter.game_id || undefined,
      });
      jobs.push(job);
    } catch (error) {
      // Skip restricted games or other errors
      log.warn({ chapter: chapter.name, tenantId, error: (error as Error).message }, 'Skipping game upload job');
    }
  }

  return jobs;
}

// ============== Enqueue Helpers ==============

/**
 * Enqueues a YouTube VOD upload job.
 * @param job - The VOD upload job data
 * @param downloadJobId - Optional: if provided, chains upload to wait for download completion
 * @returns The job ID if successfully enqueued, null otherwise
 */
export async function enqueueVodUpload(job: YoutubeVodUploadJob, downloadJobId?: string): Promise<string | null> {
  const queue = getYoutubeUploadQueue();
  const jobId = `youtube_${job.vodId}_vod`;

  try {
    if (downloadJobId) {
      const flow = await flowProducer.add({
        name: 'youtube_upload',
        queueName: queue.name,
        data: job,
        opts: {
          jobId,
          deduplication: { id: jobId },
          removeOnComplete: true,
          removeOnFail: true,
        },
        children: [
          {
            name: 'standard_vod_download',
            queueName: getStandardVodQueue().name,
            opts: { jobId: downloadJobId },
          },
        ],
      });
      return flow.job.id ?? null;
    }

    const addedJob = await queue.add('youtube_upload', job, {
      jobId,
      deduplication: { id: jobId },
      removeOnComplete: true,
      removeOnFail: true,
    });
    return addedJob.id ?? null;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.includes('deduplication')) {
      log.error({ jobId, tenantId: job.tenantId, error: msg }, 'Failed to enqueue YouTube VOD upload');
    }
    return null;
  }
}

/**
 * Enqueues a YouTube game upload job.
 * @param job - The game upload job data
 * @param downloadJobId - Optional: if provided, chains upload to wait for download completion
 * @returns The job ID if successfully enqueued, null otherwise
 */
export async function enqueueGameUpload(job: YoutubeGameUploadJob, downloadJobId?: string): Promise<string | null> {
  const queue = getYoutubeUploadQueue();
  const jobId = `youtube_${job.vodId}_game_${job.chapterId}_${job.chapterStart}`;

  try {
    if (downloadJobId) {
      const flow = await flowProducer.add({
        name: 'youtube_upload',
        queueName: queue.name,
        data: job,
        opts: {
          jobId,
          deduplication: { id: jobId },
          removeOnComplete: true,
          removeOnFail: true,
        },
        children: [
          {
            name: 'standard_vod_download',
            queueName: getStandardVodQueue().name,
            opts: { jobId: downloadJobId },
            data: {},
          },
        ],
      });
      return flow.job.id ?? null;
    }

    const addedJob = await queue.add('youtube_upload', job, {
      jobId,
      deduplication: { id: jobId },
      removeOnComplete: true,
      removeOnFail: true,
    });
    return addedJob.id ?? null;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.includes('deduplication')) {
      log.error({ jobId, tenantId: job.tenantId, error: msg }, 'Failed to enqueue YouTube game upload');
    }
    return null;
  }
}

// ============== Queue Triggers ==============

/**
 * Creates and enqueues a YouTube VOD upload job.
 * @param ctx - Tenant context
 * @param dbId - Database VOD ID
 * @param vodId - Platform VOD ID
 * @param filePath - Path to video file
 * @param platform - Source platform
 * @param downloadJobId - Optional: chains upload to wait for download
 * @returns The job ID if successfully enqueued, null otherwise
 */
export async function queueYoutubeVodUpload(
  ctx: TenantContext,
  dbId: number,
  vodId: string,
  filePath: string | undefined,
  platform: Platform,
  downloadJobId?: string,
  part?: number
): Promise<string | null> {
  const job = await createVodUploadJob(ctx, dbId, vodId, filePath, platform, part);
  return enqueueVodUpload(job, downloadJobId);
}

/**
 * Creates and enqueues a YouTube game upload job for a specific chapter.
 * @param ctx - Tenant context
 * @param dbId - Database VOD ID
 * @param vodId - Platform VOD ID
 * @param filePath - Path to video file
 * @param platform - Source platform
 * @param chapterId - Chapter ID to upload
 * @param downloadJobId - Optional: chains upload to wait for download
 * @returns The job ID if successfully enqueued, null otherwise
 */
export async function queueYoutubeGameUpload(
  ctx: TenantContext,
  dbId: number,
  vodId: string,
  filePath: string | undefined,
  platform: Platform,
  chapterId: number,
  downloadJobId?: string
): Promise<string | null> {
  const chapter = await withDbRetry(ctx.tenantId, ctx.config, async (db) => {
    return db.chapter.findUnique({ where: { id: chapterId } });
  });

  if (!chapter) return null;

  const job = await createGameUploadJob(ctx, dbId, vodId, filePath, platform, {
    id: chapter.id,
    name: chapter.name || '',
    start: chapter.start ?? 0,
    end: chapter.end ?? 0,
    gameId: chapter.game_id || undefined,
  });

  return enqueueGameUpload(job, downloadJobId);
}

/**
 * Creates and enqueues YouTube game upload jobs for all chapters in a VOD.
 * Processes sequentially (one game at a time).
 * @param ctx - Tenant context
 * @param dbId - Database VOD ID
 * @param vodId - Platform VOD ID
 * @param filePath - Path to video file
 * @param platform - Source platform
 * @param downloadJobId - Optional: chains all uploads to wait for download
 * @returns Promise that resolves when all jobs are enqueued
 */
export async function queueYoutubeGameUploadsForVod(ctx: TenantContext, dbId: number, vodId: string, filePath: string | undefined, platform: Platform, downloadJobId?: string): Promise<void> {
  const jobs = await createGameUploadJobsForVod(ctx, dbId, vodId, filePath, platform);

  for (const job of jobs) {
    await enqueueGameUpload(job, downloadJobId);
  }
}

// ============== Upload Queue Helpers ==============

/**
 * Options for queuing YouTube uploads.
 */
export interface QueueYoutubeUploadsOptions {
  ctx: TenantContext;
  dbId: number;
  vodId: string;
  filePath?: string;
  platform: Platform;
  uploadMode?: UploadMode;
  /**
   * Optional download job ID. If provided, uploads are chained to wait for
   * download completion. If undefined, uploads are queued immediately (file exists).
   */
  downloadJobId?: string;
}

export interface YoutubeUploadJobResult {
  vodJobId: string | null;
  gameJobIds: string[];
}

/**
 * Queues YouTube VOD and/or game uploads based on configuration and upload mode.
 * @param options - Queue options including context, file path, and upload mode
 * @returns Promise that resolves when all applicable uploads are queued
 */
export async function queueYoutubeUploads(options: QueueYoutubeUploadsOptions): Promise<YoutubeUploadJobResult> {
  const { ctx, dbId, vodId, filePath, platform, uploadMode = UPLOAD_MODES.ALL, downloadJobId } = options;
  const { config } = ctx;

  const result: YoutubeUploadJobResult = {
    vodJobId: null,
    gameJobIds: [],
  };

  // VOD Upload
  if ((uploadMode === UPLOAD_MODES.VOD || uploadMode === UPLOAD_MODES.ALL) && config?.youtube?.vodUpload) {
    try {
      const vodJobId = await queueYoutubeVodUpload(ctx, dbId, vodId, filePath, platform, downloadJobId);
      result.vodJobId = vodJobId;
      log.info({ vodId, chained: !!downloadJobId, vodJobId }, 'Queued YouTube VOD upload');
    } catch (error) {
      log.warn({ error: (error as Error).message, vodId }, 'Failed to queue YouTube VOD upload');
    }
  }

  // Game Uploads
  if (uploadMode === UPLOAD_MODES.ALL && config?.youtube?.perGameUpload) {
    try {
      const jobs = await createGameUploadJobsForVod(ctx, dbId, vodId, filePath, platform);

      for (const job of jobs) {
        const gameJobId = await enqueueGameUpload(job, downloadJobId);
        if (gameJobId) {
          result.gameJobIds.push(gameJobId);
        }
      }

      log.info({ vodId, chained: !!downloadJobId, gameJobsCount: result.gameJobIds.length }, 'Queued YouTube game uploads');
    } catch (error) {
      log.warn({ error: (error as Error).message, vodId }, 'Failed to queue YouTube game uploads');
    }
  }

  return result;
}
