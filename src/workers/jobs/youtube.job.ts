import { getFlowProducer, getStandardVodQueue, getYoutubeUploadQueue } from '../queues/queue.js';
import type { YoutubeVodUploadJob, YoutubeGameUploadJob } from './types.js';
import dayjs from '../../utils/dayjs.js';
import { childLogger } from '../../utils/logger.js';
import type { Platform, SourceType, UploadMode } from '../../types/platforms.js';
import { UPLOAD_MODES } from '../../types/platforms.js';
import { TenantContext } from '../../types/context.js';
import { withDbRetry } from '../../db/streamer-client.js';
import { extractErrorDetails } from '../../utils/error.js';
import { getPlatformConfig, getDisplayName } from '../../config/types.js';
import { ConfigNotConfiguredError, VodNotFoundError } from '../../utils/domain-errors.js';

const log = childLogger({ module: 'youtube-job' });

// ============== VOD Job Creation ==============

export function createVodUploadJob(
  ctx: TenantContext,
  dbId: number,
  vodId: string,
  filePath: string | undefined,
  platform: Platform,
  type: SourceType,
  dmcaProcessed?: boolean,
  part?: number
): YoutubeVodUploadJob {
  const { config, tenantId } = ctx;
  if (config.youtube?.upload === false) {
    throw new ConfigNotConfiguredError(`YouTube upload for tenant ${tenantId}`);
  }

  return {
    kind: 'vod',
    tenantId,
    dbId,
    vodId,
    filePath,
    type,
    platform,
    dmcaProcessed,
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
  chapter: { id: number; name: string; start: number; end: number; gameId?: string | undefined },
  options?: { title?: string | undefined }
): Promise<YoutubeGameUploadJob> {
  const { config, tenantId } = ctx;
  if (config.youtube?.upload === false) {
    throw new ConfigNotConfiguredError(`YouTube upload for tenant ${tenantId}`);
  }

  const platformCfg = getPlatformConfig(config, platform);
  if (platformCfg?.mainPlatform !== true) {
    throw new Error(`Skipping upload because ${platform} mainPlatform is false`);
  }

  const vodRecord = await withDbRetry(ctx.tenantId, ctx.config, async (db) => {
    return db.selectFrom('vods').where('id', '=', dbId).selectAll().executeTakeFirst();
  });

  if (!vodRecord) {
    throw new VodNotFoundError(dbId, 'youtube job');
  }

  // Check restricted games
  if (config.youtube?.restrictedGames != null && config.youtube.restrictedGames.includes(chapter.name)) {
    throw new Error(`Game "${chapter.name}" is in restricted games list`);
  }

  // Use provided title/description or generate new ones
  const channelName = getDisplayName(config);
  const vodStreamTitle = vodRecord.title != null && vodRecord.title !== '' ? vodRecord.title.replace(/>|</gi, '') : '';
  const domainName = config.settings?.domainName;

  let title: string;
  const description: string = `Chat Replay: https://${domainName}/games/${vodId}\nStream Title: ${vodStreamTitle}\n${config.youtube?.description}`;
  const dateFormatted = dayjs(vodRecord.created_at)
    .tz(config.settings?.timezone ?? 'UTC')
    .format('MMMM DD YYYY')
    .toUpperCase();

  if (options?.title != null) {
    title = `${channelName} plays ${options.title} - ${dateFormatted}`;
  } else {
    const gameCount = await withDbRetry(ctx.tenantId, ctx.config, async (db) => {
      const result = await db
        .selectFrom('games')
        .select((eb) => eb.fn.count<number>('id').as('cnt'))
        .where('game_name', '=', chapter.name)
        .where('vod_id', '!=', dbId)
        .executeTakeFirst();
      return result?.cnt ?? 0;
    });
    const epNumber = gameCount + 1;
    title = `${channelName} plays ${chapter.name} EP ${epNumber} - ${dateFormatted}`;
  }

  return {
    kind: 'game',
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

export async function createGameUploadJobsForVod(
  ctx: TenantContext,
  dbId: number,
  vodId: string,
  filePath: string | undefined,
  platform: Platform
): Promise<YoutubeGameUploadJob[]> {
  const { config, tenantId } = ctx;
  if (config.youtube?.perGameUpload !== true) {
    return [];
  }

  if (config.youtube?.upload == false) {
    throw new ConfigNotConfiguredError(`YouTube upload for tenant ${tenantId}`);
  }

  const platformCfg = getPlatformConfig(config, platform);
  if (platformCfg?.mainPlatform !== true) {
    throw new Error(`Skipping upload because ${platform} mainPlatform is false`);
  }

  // Fetch all chapters for this VOD
  const chapters = await withDbRetry(ctx.tenantId, ctx.config, async (db) => {
    return db.selectFrom('chapters').where('vod_id', '=', dbId).orderBy('start', 'asc').selectAll().execute();
  });

  const jobs: YoutubeGameUploadJob[] = [];

  for (const chapter of chapters) {
    try {
      const job = await createGameUploadJob(ctx, dbId, vodId, filePath, platform, {
        id: chapter.id,
        name: chapter.name ?? '',
        start: chapter.start ?? 0,
        end: chapter.end ?? 0,
        gameId: chapter.game_id ?? undefined,
      });
      jobs.push(job);
    } catch (error) {
      // Skip restricted games or other errors
      const details = extractErrorDetails(error);
      log.warn({ chapter: chapter.name, tenantId, ...details }, 'Skipping game upload job');
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
  const jobId = `youtube_${job.vodId}_vod_${job.part ?? 1}`;

  try {
    if (downloadJobId != null) {
      const flow = await getFlowProducer().add({
        name: 'youtube_upload',
        queueName: queue.name,
        data: { ...job, filePath: undefined },
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
    const msg = extractErrorDetails(error).message;
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
    if (downloadJobId != null) {
      const flow = await getFlowProducer().add({
        name: 'youtube_upload',
        queueName: queue.name,
        data: { ...job, filePath: undefined },
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
    const msg = extractErrorDetails(error).message;
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
 * @param dmcaProcessed - from dmca worker?
 * @param downloadJobId - Optional: chains upload to wait for download
 * @returns The job ID if successfully enqueued, null otherwise
 */
export async function queueYoutubeVodUpload(
  ctx: TenantContext,
  dbId: number,
  vodId: string,
  filePath: string | undefined,
  platform: Platform,
  type: SourceType,
  dmcaProcessed?: boolean,
  downloadJobId?: string,
  part?: number
): Promise<string | null> {
  const job = createVodUploadJob(ctx, dbId, vodId, filePath, platform, type, dmcaProcessed, part);
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
    return db.selectFrom('chapters').where('id', '=', chapterId).selectAll().executeTakeFirst();
  });

  if (!chapter) return null;

  let job: YoutubeGameUploadJob;
  try {
    job = await createGameUploadJob(ctx, dbId, vodId, filePath, platform, {
      id: chapter.id,
      name: chapter.name ?? '',
      start: chapter.start ?? 0,
      end: chapter.end ?? 0,
      gameId: chapter.game_id ?? undefined,
    });
  } catch (error) {
    const details = extractErrorDetails(error);
    log.warn({ chapterId, tenantId: ctx.tenantId, ...details }, 'Skipping game upload job');
    return null;
  }

  return enqueueGameUpload(job, downloadJobId);
}

/**
 * Creates and enqueues a YouTube game upload job for a specific game record.
 * Uses the game's own start/end times, NOT the chapter's full range.
 * This ensures re-uploading a gameId only re-uploads that exact segment.
 * @param ctx - Tenant context
 * @param dbId - Database VOD ID
 * @param vodId - Platform VOD ID
 * @param filePath - Path to video file
 * @param platform - Source platform
 * @param game - Game record with id, name, start_time, end_time, game_id
 * @param downloadJobId - Optional: chains upload to wait for download
 * @returns The job ID if successfully enqueued, null otherwise
 */
export async function queueYoutubeGameUploadByGame(
  ctx: TenantContext,
  dbId: number,
  vodId: string,
  filePath: string | undefined,
  platform: Platform,
  game: {
    id: number;
    name: string;
    start: number;
    end: number;
    gameId?: string | undefined;
    title?: string | undefined;
  },
  downloadJobId?: string
): Promise<string | null> {
  let job: YoutubeGameUploadJob;
  try {
    job = await createGameUploadJob(
      ctx,
      dbId,
      vodId,
      filePath,
      platform,
      {
        id: game.id,
        name: game.name,
        start: game.start,
        end: game.end,
        gameId: game.gameId,
      },
      {
        title: game.title,
      }
    );
  } catch (error) {
    const details = extractErrorDetails(error);
    log.warn({ gameId: game.id, tenantId: ctx.tenantId, ...details }, 'Skipping game upload job');
    return null;
  }

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
export async function queueYoutubeGameUploadsForVod(
  ctx: TenantContext,
  dbId: number,
  vodId: string,
  filePath: string | undefined,
  platform: Platform,
  downloadJobId?: string
): Promise<void> {
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
  filePath?: string | undefined;
  platform: Platform;
  uploadMode?: UploadMode | undefined;
  dmcaProcessed?: boolean | undefined;
  /**
   * Optional download job ID. If provided, uploads are chained to wait for
   * download completion. If undefined, uploads are queued immediately (file exists).
   */
  downloadJobId?: string | undefined;
  type: SourceType;
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
  const {
    ctx,
    dbId,
    vodId,
    filePath,
    platform,
    uploadMode = UPLOAD_MODES.ALL,
    downloadJobId,
    type,
    dmcaProcessed,
  } = options;
  const { config } = ctx;

  const result: YoutubeUploadJobResult = {
    vodJobId: null,
    gameJobIds: [],
  };

  // VOD Upload
  if (
    (uploadMode === UPLOAD_MODES.VOD || uploadMode === UPLOAD_MODES.ALL) &&
    config.youtube?.upload === true &&
    config.youtube?.vodUpload === true
  ) {
    try {
      const vodJobId = await queueYoutubeVodUpload(
        ctx,
        dbId,
        vodId,
        filePath,
        platform,
        type,
        dmcaProcessed,
        downloadJobId
      );
      result.vodJobId = vodJobId;
      log.info({ vodId, chained: downloadJobId != null, vodJobId }, 'Queued YouTube VOD upload');
    } catch (error) {
      const details = extractErrorDetails(error);
      log.warn({ ...details, vodId }, 'Failed to queue YouTube VOD upload');
    }
  }

  // Game Uploads
  if (uploadMode === UPLOAD_MODES.ALL && config?.youtube?.perGameUpload === true) {
    try {
      const jobs = await createGameUploadJobsForVod(ctx, dbId, vodId, filePath, platform);

      for (const job of jobs) {
        const gameJobId = await enqueueGameUpload(job, downloadJobId);
        if (gameJobId != null) {
          result.gameJobIds.push(gameJobId);
        }
      }

      log.info(
        { vodId, chained: downloadJobId != null, gameJobsCount: result.gameJobIds.length },
        'Queued YouTube game uploads'
      );
    } catch (error) {
      const details = extractErrorDetails(error);
      log.warn({ ...details, vodId }, 'Failed to queue YouTube game uploads');
    }
  }

  return result;
}
