import { getPlatformConfig, getDisplayName } from '../../config/types.js';
import { Jobs } from '../../constants.js';
import { findVodById } from '../../db/queries/vods.js';
import { withDbRetry } from '../../db/streamer-client.js';
import { SelectableChapters, SelectableGames } from '../../db/streamer-types.js';
import { TenantContext } from '../../types/context.js';
import type { Platform, SourceType, UploadMode } from '../../types/platforms.js';
import { UPLOAD_MODES } from '../../types/platforms.js';
import {
  ConfigNotConfiguredError,
  PlatformNotMainSourceError,
  RestrictedGameError,
  VodNotFoundError,
} from '../../utils/domain-errors.js';
import { extractErrorDetails } from '../../utils/error.js';
import { childLogger } from '../../utils/logger.js';
import { getFlowProducer, getStandardVodQueue, getYoutubeUploadQueue } from '../queues/queue.js';
import { buildYoutubeMetadata } from '../youtube/metadata-builder.js';
import { enqueueJobWithLogging } from './enqueue.js';
import type { YoutubeVodUploadJob, YoutubeGameUploadJob } from './types.js';

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
    part,
  };
}

// ============== Game Job Creation ==============

export async function createGameUploadJob(
  ctx: TenantContext,
  dbId: number,
  vodId: string,
  filePath: string | undefined,
  platform: Platform,
  chapter: SelectableChapters,
  options?: { gameTitle?: string | undefined }
): Promise<YoutubeGameUploadJob> {
  const { config, tenantId } = ctx;
  if (config.youtube?.upload === false) {
    throw new ConfigNotConfiguredError(`YouTube upload for tenant ${tenantId}`);
  }

  const platformCfg = getPlatformConfig(config, platform);
  if (platformCfg?.mainPlatform !== true) {
    throw new PlatformNotMainSourceError(platform);
  }

  const vodRecord = await withDbRetry(ctx.tenantId, ctx.config, async (db) => {
    return findVodById(db, dbId);
  });

  if (!vodRecord) {
    throw new VodNotFoundError(dbId, 'youtube job');
  }

  // Check restricted games
  if (config.youtube?.restrictedGames != null && config.youtube.restrictedGames.includes(chapter.name)) {
    throw new RestrictedGameError(chapter.name ?? '');
  }

  // Skip chapters shorter than 5 minutes
  if ((chapter.duration ?? 0) < 300) {
    throw new Error(`Chapter "${chapter.name}" duration (${chapter.duration}s) is less than 5 minutes`);
  }

  const channelName = getDisplayName(config);
  const gameName = chapter.name ?? '';

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

  const { description } = buildYoutubeMetadata({
    channelName,
    platform,
    domainName: config.settings?.domainName ?? '',
    timezone: config.settings?.timezone ?? 'UTC',
    youtubeDescription: config.youtube?.description,
    gameName,
    epNumber,
    vodRecord,
  });

  return {
    kind: 'game',
    tenantId,
    dbId,
    vodId,
    filePath,
    type: 'game',
    platform,
    chapterId: chapter.id,
    chapterName: chapter.name ?? '',
    chapterStart: chapter.start,
    chapterDuration: chapter.duration,
    chapterEnd: chapter.end ?? 0,
    chapterGameId: chapter.game_id ?? '',
    chapterImage: chapter.image ?? null,
    description,
    epNumber,
    gameTitle: options?.gameTitle,
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
    throw new PlatformNotMainSourceError(platform);
  }

  // Fetch all chapters for this VOD
  const chapters = await withDbRetry(ctx.tenantId, ctx.config, async (db) => {
    return db.selectFrom('chapters').where('vod_id', '=', dbId).orderBy('start', 'asc').selectAll().execute();
  });

  const jobs: YoutubeGameUploadJob[] = [];

  for (const chapter of chapters) {
    try {
      const job = await createGameUploadJob(ctx, dbId, vodId, filePath, platform, chapter);
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
  const jobId = `${Jobs.YOUTUBE_JOB_PREFIX}${job.vodId}_vod_${job.part ?? 1}`;

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

    const result = await enqueueJobWithLogging({
      queue,
      jobName: 'youtube_upload',
      data: job,
      options: {
        jobId,
        removeOnComplete: true,
        removeOnFail: true,
      },
      logger: { info: log.info.bind(log), debug: log.debug.bind(log) },
      successMessage: 'YouTube VOD upload job enqueued',
      extraContext: { tenantId: job.tenantId, vodId: job.vodId, part: job.part },
    });
    return result.isNew ? result.jobId : null;
  } catch (error) {
    const msg = extractErrorDetails(error).message;
    if (downloadJobId == null) {
      log.error({ jobId, tenantId: job.tenantId, error: msg }, 'Failed to enqueue YouTube VOD upload');
    } else {
      log.debug({ jobId, tenantId: job.tenantId, error: msg }, 'YouTube VOD upload enqueue failed (chained)');
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
  const jobId = `${Jobs.YOUTUBE_JOB_PREFIX}${job.vodId}_game_${job.chapterId}_${job.chapterStart}`;

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

    const result = await enqueueJobWithLogging({
      queue,
      jobName: 'youtube_upload',
      data: job,
      options: {
        jobId,
        removeOnComplete: true,
        removeOnFail: true,
      },
      logger: { info: log.info.bind(log), debug: log.debug.bind(log) },
      successMessage: 'YouTube game upload job enqueued',
      extraContext: { tenantId: job.tenantId, vodId: job.vodId, chapterId: job.chapterId },
    });
    return result.isNew ? result.jobId : null;
  } catch (error) {
    const msg = extractErrorDetails(error).message;
    if (downloadJobId == null) {
      log.error({ jobId, tenantId: job.tenantId, error: msg }, 'Failed to enqueue YouTube game upload');
    } else {
      log.debug({ jobId, tenantId: job.tenantId, error: msg }, 'YouTube game upload enqueue failed (chained)');
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
    job = await createGameUploadJob(ctx, dbId, vodId, filePath, platform, chapter);
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
  game: SelectableGames,
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
        vod_id: game.vod_id,
        game_id: game.game_id,
        name: game.game_name,
        image: game.chapter_image,
        start: game.start,
        duration: game.duration,
        end: game.end,
      },
      {
        gameTitle: game.title ?? undefined,
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

  const queue = getYoutubeUploadQueue();
  const vodUploadEnabled = config.youtube?.upload === true && config.youtube?.vodUpload === true;
  const gameUploadEnabled = config?.youtube?.perGameUpload === true;

  // ALL mode with both game and VOD uploads: chain games -> VOD so VOD waits for games
  if (uploadMode === UPLOAD_MODES.ALL && gameUploadEnabled && vodUploadEnabled) {
    try {
      const gameJobs = await createGameUploadJobsForVod(ctx, dbId, vodId, filePath, platform);
      const gameJobIds: string[] = [];

      for (const job of gameJobs) {
        const gameJobId = `youtube_${vodId}_game_${job.chapterId}_${job.chapterStart}`;
        gameJobIds.push(gameJobId);
      }

      const vodJobId = `youtube_${vodId}_vod_1`;

      if (downloadJobId != null) {
        // Flow: VOD -> [games] -> download (grandchildren)
        const flowChildren = gameJobs.map((job, idx) => ({
          name: 'youtube_upload',
          queueName: queue.name,
          data: { ...job, filePath: undefined },
          opts: { jobId: gameJobIds[idx] ?? '', removeOnComplete: true, removeOnFail: true },
          children: [
            {
              name: 'standard_vod_download',
              queueName: getStandardVodQueue().name,
              opts: { jobId: downloadJobId },
            },
          ],
        }));

        const flow = await getFlowProducer().add({
          name: 'youtube_upload',
          queueName: queue.name,
          data: {
            kind: 'vod',
            tenantId: ctx.tenantId,
            dbId,
            vodId,
            filePath: undefined,
            type,
            platform,
            dmcaProcessed,
          },
          opts: {
            jobId: vodJobId,
            removeOnComplete: true,
            removeOnFail: true,
          },
          children: flowChildren,
        });

        result.vodJobId = flow.job.id ?? null;
        result.gameJobIds = gameJobIds;
      } else {
        // Flow: VOD -> [games] (file exists, no download dependency)
        const flowChildren = gameJobs.map((job, idx) => ({
          name: 'youtube_upload',
          queueName: queue.name,
          data: job,
          opts: { jobId: gameJobIds[idx] ?? '', removeOnComplete: true, removeOnFail: true },
        }));

        const flow = await getFlowProducer().add({
          name: 'youtube_upload',
          queueName: queue.name,
          data: {
            kind: 'vod',
            tenantId: ctx.tenantId,
            dbId,
            vodId,
            filePath: undefined,
            type,
            platform,
            dmcaProcessed,
          },
          opts: {
            jobId: vodJobId,
            removeOnComplete: true,
            removeOnFail: true,
          },
          children: flowChildren,
        });

        result.vodJobId = flow.job.id ?? null;
        result.gameJobIds = gameJobIds;
      }

      log.info(
        { vodId, chained: downloadJobId != null, gameJobsCount: result.gameJobIds.length },
        'Queued YouTube game uploads'
      );
      log.info({ vodId, chained: downloadJobId != null, vodJobId: result.vodJobId }, 'Queued YouTube VOD upload');
    } catch (error) {
      const details = extractErrorDetails(error);
      log.warn({ ...details, vodId }, 'Failed to queue YouTube uploads');
    }
  } else {
    // Game Uploads (ALL mode, no VOD or VOD not enabled)
    if (uploadMode === UPLOAD_MODES.ALL && gameUploadEnabled) {
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

    // VOD Upload (VOD mode, or ALL mode without game uploads)
    if (
      (uploadMode === UPLOAD_MODES.VOD || (!gameUploadEnabled && uploadMode === UPLOAD_MODES.ALL)) &&
      vodUploadEnabled
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
  }

  return result;
}
