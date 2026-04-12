import { getTenantConfig } from '../../config/loader.js';
import { getClient } from '../../db/client.js';
import { getYoutubeUploadQueue } from './queues.js';
import type { YoutubeVodUploadJob, YoutubeGameUploadJob } from './queues.js';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(timezone);

// ============== VOD Job Creation ==============

export async function createVodUploadJob(tenantId: string, dbId: number, vodId: string, filePath: string, platform: 'twitch' | 'kick'): Promise<YoutubeVodUploadJob> {
  const config = getTenantConfig(tenantId);
  if (!config?.youtube?.upload) {
    throw new Error(`YouTube upload not enabled for tenant ${tenantId}`);
  }

  const client = getClient(tenantId);
  if (!client) {
    throw new Error(`Database client not available for tenant ${tenantId}`);
  }

  const vodRecord = await client.vod.findUnique({ where: { id: dbId } });
  if (!vodRecord) {
    throw new Error(`VOD record not found for dbId ${dbId}`);
  }

  return {
    tenantId,
    dbId,
    vodId,
    filePath,
    type: 'vod',
    platform,
  };
}

// ============== Game Job Creation ==============

export async function createGameUploadJob(
  tenantId: string,
  dbId: number,
  vodId: string,
  filePath: string,
  platform: 'twitch' | 'kick',
  chapter: { id: number; name: string; start: number; end: number; gameId?: string }
): Promise<YoutubeGameUploadJob> {
  const config = getTenantConfig(tenantId);
  if (!config?.youtube?.upload) {
    throw new Error(`YouTube upload not enabled for tenant ${tenantId}`);
  }

  const client = getClient(tenantId);
  if (!client) {
    throw new Error(`Database client not available for tenant ${tenantId}`);
  }

  const vodRecord = await client.vod.findUnique({ where: { id: dbId } });
  if (!vodRecord) {
    throw new Error(`VOD record not found for dbId ${dbId}`);
  }

  // Check restricted games
  if (config.youtube.restrictedGames.includes(chapter.name || '')) {
    throw new Error(`Game "${chapter.name}" is in restricted games list`);
  }

  // Calculate EP number (global count across all VODs)
  const gameCount = await client.game.count({
    where: {
      game_name: chapter.name,
      vod_id: { not: dbId },
    },
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

export async function createGameUploadJobsForVod(tenantId: string, dbId: number, vodId: string, filePath: string, platform: 'twitch' | 'kick'): Promise<YoutubeGameUploadJob[]> {
  const config = getTenantConfig(tenantId);
  if (!config?.youtube?.perGameUpload) {
    return [];
  }

  const client = getClient(tenantId);
  if (!client) {
    return [];
  }

  // Fetch all chapters for this VOD
  const chapters = await client.chapter.findMany({
    where: { vod_id: dbId },
    orderBy: { start: 'asc' },
  });

  const jobs: YoutubeGameUploadJob[] = [];

  for (const chapter of chapters) {
    try {
      const job = await createGameUploadJob(tenantId, dbId, vodId, filePath, platform, {
        id: chapter.id,
        name: chapter.name || '',
        start: chapter.start ?? 0,
        end: chapter.end ?? 0,
        gameId: chapter.game_id || undefined,
      });
      jobs.push(job);
    } catch (error) {
      // Skip restricted games or other errors
      const { createAutoLogger } = await import('../../utils/auto-tenant-logger.js');
      const log = createAutoLogger(tenantId);
      log.warn({ chapter: chapter.name, error: (error as Error).message }, 'Skipping game upload job');
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
  } catch {
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
  } catch {
    return null;
  }
}

// ============== Queue Triggers ==============

export async function queueYoutubeVodUpload(tenantId: string, dbId: number, vodId: string, filePath: string, platform: 'twitch' | 'kick'): Promise<string | null> {
  const job = await createVodUploadJob(tenantId, dbId, vodId, filePath, platform);
  return enqueueVodUpload(job);
}

export async function queueYoutubeGameUpload(tenantId: string, dbId: number, vodId: string, filePath: string, platform: 'twitch' | 'kick', chapterId: number): Promise<string | null> {
  const client = getClient(tenantId);
  if (!client) return null;

  const chapter = await client.chapter.findUnique({ where: { id: chapterId } });
  if (!chapter) return null;

  const job = await createGameUploadJob(tenantId, dbId, vodId, filePath, platform, {
    id: chapter.id,
    name: chapter.name || '',
    start: chapter.start ?? 0,
    end: chapter.end ?? 0,
    gameId: chapter.game_id || undefined,
  });

  return enqueueGameUpload(job);
}

export async function queueYoutubeGameUploadsForVod(tenantId: string, dbId: number, vodId: string, filePath: string, platform: 'twitch' | 'kick'): Promise<void> {
  const jobs = await createGameUploadJobsForVod(tenantId, dbId, vodId, filePath, platform);

  for (const job of jobs) {
    await enqueueGameUpload(job);
  }
}

// ============== Backward Compatibility ==============

// DEPRECATED: Use queueYoutubeVodUpload or queueYoutubeGameUpload instead
export async function triggerYoutubeUpload(
  tenantId: string,
  dbId: number,
  vodId: string,
  filePath: string,
  _title: string,
  _description: string,
  type: 'vod' | 'game',
  platform?: 'twitch' | 'kick',
  _part?: number
): Promise<string | null> {
  if (type === 'vod' && platform) {
    return queueYoutubeVodUpload(tenantId, dbId, vodId, filePath, platform);
  }
  return null;
}

// ============== Upload Queue Helpers ==============

export interface QueueYoutubeUploadsOptions {
  tenantId: string;
  dbId: number;
  vodId: string;
  filePath: string;
  platform: 'twitch' | 'kick';
  uploadMode?: 'vod' | 'all';
  config: ReturnType<typeof getTenantConfig>;
  log: {
    info: (ctx: Record<string, unknown>, msg: string) => void;
    warn: (ctx: Record<string, unknown>, msg: string) => void;
  };
}

export async function queueYoutubeUploads(options: QueueYoutubeUploadsOptions): Promise<void> {
  const { tenantId, dbId, vodId, filePath, platform, uploadMode = 'vod', config, log } = options;

  // VOD Upload
  if ((uploadMode === 'vod' || uploadMode === 'all') && config?.youtube?.vodUpload) {
    try {
      await queueYoutubeVodUpload(tenantId, dbId, vodId, filePath, platform);
      log.info({ vodId }, 'Queued YouTube VOD upload');
    } catch (error) {
      log.warn({ error: (error as Error).message, vodId }, 'Failed to queue YouTube VOD upload');
    }
  }

  // Game Uploads
  if (uploadMode === 'all' && config?.youtube?.perGameUpload) {
    try {
      await queueYoutubeGameUploadsForVod(tenantId, dbId, vodId, filePath, platform);
      log.info({ vodId }, 'Queued YouTube game uploads');
    } catch (error) {
      log.warn({ error: (error as Error).message, vodId }, 'Failed to queue YouTube game uploads');
    }
  }
}
