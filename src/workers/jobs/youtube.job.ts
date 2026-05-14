import { getPlatformConfig } from '../../config/types.js';
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
import {
  getFlowProducer,
  getFileCopyQueue,
  getStandardVodQueue,
  getYoutubeUploadQueue,
  getVodFinalizeFileQueue,
} from '../queues/queue.js';
import { enqueueJobWithLogging } from './enqueue.js';
import type { YoutubeVodUploadJob, YoutubeGameUploadJob } from './types.js';

const log = childLogger({ module: 'youtube-job' });

// ============== VOD Job Creation ==============

function createVodUploadJob(
  ctx: TenantContext,
  dbId: number,
  vodId: string,
  filePath: string | undefined,
  platform: Platform,
  type: SourceType,
  dmcaProcessed?: boolean,
  part?: number,
  options?: { workDir?: string; skipFinalize?: boolean; streamId?: string }
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
    workDir: options?.workDir,
    skipFinalize: options?.skipFinalize,
    streamId: options?.streamId,
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

  const gameCount = await withDbRetry(ctx.tenantId, ctx.config, async (db) => {
    const result = await db
      .selectFrom('games')
      .select((eb) => eb.fn.count<number>('id').as('cnt'))
      .where('game_name', '=', chapter.name)
      .where('vod_id', '!=', dbId)
      .executeTakeFirst();
    return Number(result?.cnt ?? 0);
  });
  const epNumber = gameCount + 1;

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
    epNumber,
    gameTitle: options?.gameTitle,
  };
}

// ============== Bulk Game Job Creation ==============

async function createGameUploadJobsForVod(
  ctx: TenantContext,
  dbId: number,
  vodId: string,
  filePath: string | undefined,
  platform: Platform,
  workDir?: string
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
    log.info({ platform, tenantId }, 'Skipped game uploads (platform not main source)');
    return [];
  }

  // Fetch all chapters for this VOD
  const chapters = await withDbRetry(ctx.tenantId, ctx.config, async (db) => {
    return db.selectFrom('chapters').where('vod_id', '=', dbId).orderBy('start', 'asc').selectAll().execute();
  });

  const jobs: YoutubeGameUploadJob[] = [];

  for (const chapter of chapters) {
    try {
      const job = await createGameUploadJob(ctx, dbId, vodId, filePath, platform, chapter);
      jobs.push({ ...job, workDir });
    } catch (error) {
      const details = extractErrorDetails(error);
      log.warn(
        { chapterId: chapter.id, chapterName: chapter.name, tenantId, vodId, dbId, ...details },
        'Skipping game upload job'
      );
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
async function enqueueVodUpload(
  job: YoutubeVodUploadJob,
  downloadJobId?: string,
  copyJobId?: string
): Promise<string | null> {
  const queue = getYoutubeUploadQueue();
  const jobId = `${Jobs.YOUTUBE_JOB_PREFIX}${job.vodId}_vod_${job.part ?? 1}`;

  try {
    if (downloadJobId != null || copyJobId != null) {
      const children: Array<{
        name: string;
        queueName: string;
        opts: { jobId: string; failParentOnFailure?: boolean };
        data?: Record<string, never>;
      }> = [];
      if (downloadJobId != null) {
        children.push({
          name: 'standard_vod_download',
          queueName: getStandardVodQueue().name,
          opts: { jobId: downloadJobId, failParentOnFailure: false },
        });
      }
      if (copyJobId != null) {
        children.push({
          name: 'file_copy',
          queueName: getFileCopyQueue().name,
          opts: { jobId: copyJobId, failParentOnFailure: false },
        });
      }
      const flow = await getFlowProducer().add({
        name: 'youtube_upload',
        queueName: queue.name,
        data: job,
        opts: {
          jobId,
          deduplication: { id: jobId },
          removeOnComplete: true,
          removeOnFail: true,
        },
        children,
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
    if (downloadJobId == null && copyJobId == null) {
      log.error({ jobId, tenantId: job.tenantId, error: msg }, 'Failed to enqueue YouTube VOD upload');
    } else {
      log.debug({ jobId, tenantId: job.tenantId, error: msg }, 'YouTube VOD upload enqueue failed (chained)');
    }
    return null;
  }
}

/**
 * Creates a finalize job data object for use in flow producer chains.
 */
function createFinalizeData(
  ctx: TenantContext,
  dbId: number,
  vodId: string,
  type: SourceType,
  filePath: string | undefined,
  platform: Platform,
  options?: {
    workDir?: string | undefined;
    saveMP4?: boolean | undefined;
    saveHLS?: boolean | undefined;
    streamId?: string | undefined;
  }
) {
  return {
    tenantId: ctx.tenantId,
    dbId,
    vodId,
    filePath,
    type,
    platform,
    workDir: options?.workDir,
    saveMP4: options?.saveMP4 ?? ctx.config.settings.saveMP4 ?? false,
    saveHLS: options?.saveHLS ?? ctx.config.settings.saveHLS ?? false,
    streamId: options?.streamId,
  };
}

/**
 * Creates a VOD upload job data object for use in flow producer chains.
 */
function createVodUploadData(
  ctx: TenantContext,
  dbId: number,
  vodId: string,
  type: SourceType,
  filePath: string | undefined,
  options?: {
    dmcaProcessed?: boolean | undefined;
    part?: number | undefined;
    workDir?: string | undefined;
    streamId?: string | undefined;
  }
) {
  return {
    kind: 'vod' as const,
    tenantId: ctx.tenantId,
    dbId,
    vodId,
    filePath,
    type,
    platform: undefined,
    dmcaProcessed: options?.dmcaProcessed,
    part: options?.part,
    workDir: options?.workDir,
    streamId: options?.streamId,
  };
}

/**
 * Enqueues a standalone finalize job (no flow children).
 * Used when the file already exists and needs to be finalized directly.
 */
export async function enqueueFinalizeJob(
  ctx: TenantContext,
  dbId: number,
  vodId: string,
  filePath: string,
  type: SourceType,
  platform: Platform,
  options?: {
    workDir?: string | undefined;
    saveMP4?: boolean | undefined;
    saveHLS?: boolean | undefined;
    streamId?: string | undefined;
  }
): Promise<string | null> {
  const queue = getVodFinalizeFileQueue();
  const jobId = `${Jobs.FINALIZE_JOB_PREFIX}${vodId}_1_${Date.now()}`;

  try {
    const result = await enqueueJobWithLogging({
      queue,
      jobName: 'vod_finalize_file',
      data: {
        tenantId: ctx.tenantId,
        dbId,
        vodId,
        filePath,
        type,
        platform,
        workDir: options?.workDir,
        saveMP4: options?.saveMP4 ?? ctx.config.settings.saveMP4 ?? false,
        saveHLS: options?.saveHLS ?? ctx.config.settings.saveHLS ?? false,
        streamId: options?.streamId,
      },
      options: {
        jobId,
        removeOnComplete: true,
        removeOnFail: true,
      },
      logger: { info: log.info.bind(log), debug: log.debug.bind(log) },
      successMessage: 'VOD finalize job enqueued',
      extraContext: { tenantId: ctx.tenantId, vodId },
    });
    return result.isNew ? result.jobId : null;
  } catch (error) {
    log.error(
      { jobId, tenantId: ctx.tenantId, error: extractErrorDetails(error).message },
      'Failed to enqueue finalize job'
    );
    return null;
  }
}

/**
 * Enqueues a YouTube game upload job.
 * @param job - The game upload job data
 * @param downloadJobId - Optional: if provided, chains upload to wait for download completion
 * @returns The job ID if successfully enqueued, null otherwise
 */
async function enqueueGameUpload(
  job: YoutubeGameUploadJob,
  downloadJobId?: string,
  copyJobId?: string
): Promise<string | null> {
  const queue = getYoutubeUploadQueue();
  const jobId = `${Jobs.YOUTUBE_JOB_PREFIX}${job.vodId}_game_${job.chapterId}_${job.chapterStart}`;

  try {
    if (downloadJobId != null || copyJobId != null) {
      const children: Array<{
        name: string;
        queueName: string;
        opts: { jobId: string; failParentOnFailure?: boolean };
        data?: Record<string, never>;
      }> = [];
      if (downloadJobId != null) {
        children.push({
          name: 'standard_vod_download',
          queueName: getStandardVodQueue().name,
          opts: { jobId: downloadJobId, failParentOnFailure: false },
          data: {},
        });
      }
      if (copyJobId != null) {
        children.push({
          name: 'file_copy',
          queueName: getFileCopyQueue().name,
          opts: { jobId: copyJobId, failParentOnFailure: false },
        });
      }
      const flow = await getFlowProducer().add({
        name: 'youtube_upload',
        queueName: queue.name,
        data: job,
        opts: {
          jobId,
          deduplication: { id: jobId },
          removeOnComplete: true,
          removeOnFail: true,
        },
        children,
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
  part?: number,
  options?: { workDir?: string; skipFinalize?: boolean; streamId?: string },
  copyJobId?: string
): Promise<string | null> {
  const job = createVodUploadJob(ctx, dbId, vodId, filePath, platform, type, dmcaProcessed, part, options);
  return enqueueVodUpload(job, downloadJobId, copyJobId);
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
  downloadJobId?: string,
  workDir?: string,
  copyJobId?: string
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

  return enqueueGameUpload({ ...job, workDir }, downloadJobId, copyJobId);
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
  copyJobId?: string | undefined;
  type: SourceType;
  workDir?: string | undefined;
  streamId?: string | undefined;
  /** Force upload regardless of vodUpload config. Admin routes use this to bypass VOD upload gating. */
  forceUpload?: boolean;
}

export interface YoutubeUploadJobResult {
  vodJobId: string | null;
  gameJobIds: string[];
}

/**
 * Represents a recursive node in the BullMQ FlowProducer tree.
 */
interface SequentialFlowChild {
  name: string;
  queueName: string;
  data: Record<string, unknown>;
  opts: { jobId: string; removeOnComplete: boolean; removeOnFail: boolean; failParentOnFailure?: boolean };
  children?: Array<SequentialFlowChild | { name: string; queueName: string; opts: { jobId: string } }>;
}

/**
 * Builds a sequential chain of game upload jobs to avoid BullMQ's shared-child deadlock.
 * Chain structure: game_0 -> copy/download, game_1 -> game_0, ... , game_N -> game_(N-1)
 * Only the first game references baseChildren. Each later game depends on the previous.
 */
function buildSequentialGameChain(
  gameJobs: YoutubeGameUploadJob[],
  gameJobIds: string[],
  queueName: string,
  baseChildren: Array<{ name: string; queueName: string; opts: { jobId: string } }>,
  workDir?: string
): SequentialFlowChild | null {
  if (gameJobs.length === 0) return null;

  let prevChild: SequentialFlowChild | null = null;

  for (let i = 0; i < gameJobs.length; i++) {
    const job = gameJobs[i];
    const jobId = gameJobIds[i] ?? '';
    const isFirst = i === 0;

    // Every job gets the path directly — no need to bubble via getChildrenValues
    const data = { ...job, workDir };

    // First game depends on base children (download/copy). Each subsequent game depends on the previous.
    const children:
      | Array<SequentialFlowChild | { name: string; queueName: string; opts: { jobId: string } }>
      | undefined = isFirst
      ? baseChildren.length > 0
        ? baseChildren
        : undefined
      : prevChild != null
        ? [prevChild]
        : undefined;

    prevChild = {
      name: 'youtube_upload',
      queueName,
      data,
      opts: { jobId, removeOnComplete: true, removeOnFail: true, failParentOnFailure: false },
      ...(children != null && children.length > 0 ? { children } : {}),
    };
  }

  return prevChild;
}

/**
 * Builds children array for FlowProducer chains, including download and/or copy job dependencies.
 */
function buildCopyChildren(
  downloadJobId: string | undefined,
  copyJobId: string | undefined
): Array<{ name: string; queueName: string; opts: { jobId: string; failParentOnFailure?: boolean } }> {
  const children: Array<{ name: string; queueName: string; opts: { jobId: string; failParentOnFailure?: boolean } }> =
    [];
  if (downloadJobId != null) {
    children.push({
      name: 'standard_vod_download',
      queueName: getStandardVodQueue().name,
      opts: { jobId: downloadJobId, failParentOnFailure: false },
    });
  }
  if (copyJobId != null) {
    children.push({
      name: 'file_copy',
      queueName: getFileCopyQueue().name,
      opts: { jobId: copyJobId, failParentOnFailure: false },
    });
  }
  return children;
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
    copyJobId,
    type,
    dmcaProcessed,
    workDir,
    streamId,
  } = options;
  const { config } = ctx;
  const saveHls = config.settings.saveHLS ?? false;

  const result: YoutubeUploadJobResult = {
    vodJobId: null,
    gameJobIds: [],
  };

  const youtubeQueue = getYoutubeUploadQueue();
  const finalizeQueue = getVodFinalizeFileQueue();
  const uploadEnabled = config.youtube?.upload === true;
  const vodUploadConfig = config.youtube?.vodUpload === true;
  const vodUploadEnabled = uploadEnabled && (options.forceUpload === true || vodUploadConfig);
  const gameUploadEnabled = config?.youtube?.perGameUpload === true;

  // ALL mode: finalize <- vod_upload <- game_0 <- ... <- game_N, with game_0 -> copy/download
  if (uploadMode === UPLOAD_MODES.ALL && gameUploadEnabled && vodUploadEnabled) {
    try {
      const gameJobs = await createGameUploadJobsForVod(ctx, dbId, vodId, filePath, platform, workDir);
      const gameJobIds: string[] = [];

      for (const job of gameJobs) {
        const gameJobId = `youtube_${vodId}_game_${job.chapterId}_${job.chapterStart}`;
        gameJobIds.push(gameJobId);
      }

      const finalizeJobId = `finalize_${vodId}_1`;
      const vodJobId = `youtube_${vodId}_vod_1`;
      const baseChildren = buildCopyChildren(downloadJobId, copyJobId);

      const gameChainHead = buildSequentialGameChain(gameJobs, gameJobIds, youtubeQueue.name, baseChildren, workDir);

      const vodChild = {
        name: 'youtube_upload',
        queueName: youtubeQueue.name,
        data: createVodUploadData(ctx, dbId, vodId, type, filePath, { dmcaProcessed, workDir, streamId }),
        opts: { jobId: vodJobId, removeOnComplete: true, removeOnFail: true, failParentOnFailure: false },
        children: gameChainHead != null ? [gameChainHead] : baseChildren,
      };

      const flow = await getFlowProducer().add({
        name: 'vod_finalize_file',
        queueName: finalizeQueue.name,
        data: createFinalizeData(ctx, dbId, vodId, type, filePath, platform, { workDir, saveHLS: saveHls, streamId }),
        opts: { jobId: finalizeJobId, removeOnComplete: true, removeOnFail: true, failParentOnFailure: false },
        children: [vodChild],
      });

      result.vodJobId = flow.job.id ?? null;
      result.gameJobIds = gameJobIds;

      if (result.gameJobIds.length > 0) {
        log.info(
          { vodId, chained: downloadJobId != null, gameJobsCount: result.gameJobIds.length },
          'Queued YouTube game uploads'
        );
      } else {
        log.info({ vodId, chained: downloadJobId != null }, 'Skipped game uploads');
      }
      log.info({ vodId, chained: downloadJobId != null, vodJobId: result.vodJobId }, 'Queued YouTube VOD upload');
    } catch (error) {
      const details = extractErrorDetails(error);
      log.warn({ ...details, vodId }, 'Failed to queue YouTube uploads');
    }
  } else {
    // Game Uploads only (GAMES or ALL without VOD): finalize <- game_0 <- ... <- game_N, with game_0 -> copy/download
    if ((uploadMode === UPLOAD_MODES.GAMES || uploadMode === UPLOAD_MODES.ALL) && gameUploadEnabled) {
      try {
        const gameJobs = await createGameUploadJobsForVod(ctx, dbId, vodId, filePath, platform, workDir);
        const gameJobIds: string[] = [];

        for (const job of gameJobs) {
          const gameJobId = `youtube_${vodId}_game_${job.chapterId}_${job.chapterStart}`;
          gameJobIds.push(gameJobId);
        }

        const finalizeJobId = `finalize_${vodId}_1`;
        const baseChildren = buildCopyChildren(downloadJobId, copyJobId);

        const gameChainHead = buildSequentialGameChain(gameJobs, gameJobIds, youtubeQueue.name, baseChildren, workDir);

        const flowChildren = gameChainHead != null ? [gameChainHead] : baseChildren;

        const flow = await getFlowProducer().add({
          name: 'vod_finalize_file',
          queueName: finalizeQueue.name,
          data: createFinalizeData(ctx, dbId, vodId, type, filePath, platform, {
            workDir,
            saveHLS: saveHls,
            streamId,
          }),
          opts: { jobId: finalizeJobId, removeOnComplete: true, removeOnFail: true, failParentOnFailure: false },
          children: flowChildren,
        });

        result.vodJobId = flow.job.id ?? null;
        result.gameJobIds = gameJobIds;

        if (result.gameJobIds.length > 0) {
          log.info(
            { vodId, chained: downloadJobId != null, gameJobsCount: result.gameJobIds.length },
            'Queued YouTube game uploads'
          );
        } else {
          log.info({ vodId, chained: downloadJobId != null }, 'Skipped game uploads');
        }
        log.info({ vodId, chained: downloadJobId != null, vodJobId: result.vodJobId }, 'Queued VOD finalizer');
      } catch (error) {
        const details = extractErrorDetails(error);
        log.warn({ ...details, vodId }, 'Failed to queue YouTube game uploads');
      }
    }

    // VOD Upload only (VOD mode, or ALL mode without game uploads): finalize -> vod -> download
    if (
      (uploadMode === UPLOAD_MODES.VOD || (!gameUploadEnabled && uploadMode === UPLOAD_MODES.ALL)) &&
      vodUploadEnabled
    ) {
      try {
        const finalizeJobId = `finalize_${vodId}_1`;
        const vodJobId = `youtube_${vodId}_vod_1`;

        const vodChildBase = buildCopyChildren(downloadJobId, copyJobId);

        const vodChild = {
          name: 'youtube_upload',
          queueName: youtubeQueue.name,
          data: createVodUploadData(ctx, dbId, vodId, type, filePath, { dmcaProcessed, workDir, streamId }),
          opts: { jobId: vodJobId, removeOnComplete: true, removeOnFail: true, failParentOnFailure: false },
          ...(vodChildBase.length > 0 && { children: vodChildBase }),
        };

        const flow = await getFlowProducer().add({
          name: 'vod_finalize_file',
          queueName: finalizeQueue.name,
          data: createFinalizeData(ctx, dbId, vodId, type, filePath, platform, { workDir, saveHLS: saveHls, streamId }),
          opts: { jobId: finalizeJobId, removeOnComplete: true, removeOnFail: true, failParentOnFailure: false },
          children: [vodChild],
        });

        result.vodJobId = flow.job.id ?? null;
        log.info({ vodId, chained: downloadJobId != null, vodJobId }, 'Queued YouTube VOD upload');
      } catch (error) {
        const details = extractErrorDetails(error);
        log.warn({ ...details, vodId }, 'Failed to queue YouTube VOD upload');
      }
    }
  }

  return result;
}
