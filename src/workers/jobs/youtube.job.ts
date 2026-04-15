import { getYoutubeUploadQueue } from './queues.js';
import type { YoutubeVodUploadJob, YoutubeGameUploadJob } from './queues.js';
import dayjs from '../../utils/dayjs.js';
import { childLogger } from '../../utils/logger.js';
import type { Platform, UploadMode } from '../../types/platforms.js';
import { UPLOAD_TYPES, UPLOAD_MODES } from '../../types/platforms.js';
import { TenantContext } from '../../types/context.js';
import { withDbRetry } from '../../db/client.js';

const log = childLogger({ module: 'youtube-job' });

// ============== VOD Job Creation ==============

export async function createVodUploadJob(ctx: TenantContext, dbId: number, vodId: string, filePath: string, platform: Platform): Promise<YoutubeVodUploadJob> {
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
  };
}

// ============== Game Job Creation ==============

export async function createGameUploadJob(
  ctx: TenantContext,
  dbId: number,
  vodId: string,
  filePath: string,
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

export async function createGameUploadJobsForVod(ctx: TenantContext, dbId: number, vodId: string, filePath: string, platform: Platform): Promise<YoutubeGameUploadJob[]> {
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

export async function enqueueVodUpload(job: YoutubeVodUploadJob): Promise<string | null> {
  const queue = getYoutubeUploadQueue();
  const jobId = `youtube_${job.vodId}_vod`;

  try {
    const addedJob = await queue.add('youtube_upload', job, {
      jobId,
      deduplication: { id: jobId },
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

export async function enqueueGameUpload(job: YoutubeGameUploadJob): Promise<string | null> {
  const queue = getYoutubeUploadQueue();
  const jobId = `youtube_${job.vodId}_game_${job.chapterId}`;

  try {
    const addedJob = await queue.add('youtube_upload', job, {
      jobId,
      deduplication: { id: jobId },
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

export async function queueYoutubeVodUpload(ctx: TenantContext, dbId: number, vodId: string, filePath: string, platform: Platform): Promise<string | null> {
  const job = await createVodUploadJob(ctx, dbId, vodId, filePath, platform);
  return enqueueVodUpload(job);
}

export async function queueYoutubeGameUpload(ctx: TenantContext, dbId: number, vodId: string, filePath: string, platform: Platform, chapterId: number): Promise<string | null> {
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

  return enqueueGameUpload(job);
}

export async function queueYoutubeGameUploadsForVod(ctx: TenantContext, dbId: number, vodId: string, filePath: string, platform: Platform): Promise<void> {
  const jobs = await createGameUploadJobsForVod(ctx, dbId, vodId, filePath, platform);

  for (const job of jobs) {
    await enqueueGameUpload(job);
  }
}

// ============== Upload Queue Helpers ==============

export interface QueueYoutubeUploadsOptions {
  ctx: TenantContext;
  dbId: number;
  vodId: string;
  filePath: string;
  platform: Platform;
  uploadMode?: UploadMode;
  log: {
    info: (ctx: Record<string, unknown>, msg: string) => void;
    warn: (ctx: Record<string, unknown>, msg: string) => void;
  };
}

export async function queueYoutubeUploads(options: QueueYoutubeUploadsOptions): Promise<void> {
  const { ctx, dbId, vodId, filePath, platform, uploadMode = UPLOAD_MODES.ALL, log } = options;
  const { config } = ctx;

  // VOD Upload
  if ((uploadMode === UPLOAD_MODES.VOD || uploadMode === UPLOAD_MODES.ALL) && config?.youtube?.vodUpload) {
    try {
      await queueYoutubeVodUpload(ctx, dbId, vodId, filePath, platform);
      log.info({ vodId }, 'Queued YouTube VOD upload');
    } catch (error) {
      log.warn({ error: (error as Error).message, vodId }, 'Failed to queue YouTube VOD upload');
    }
  }

  // Game Uploads
  if (uploadMode === UPLOAD_MODES.ALL && config?.youtube?.perGameUpload) {
    try {
      await queueYoutubeGameUploadsForVod(ctx, dbId, vodId, filePath, platform);
      log.info({ vodId }, 'Queued YouTube game uploads');
    } catch (error) {
      log.warn({ error: (error as Error).message, vodId }, 'Failed to queue YouTube game uploads');
    }
  }
}
