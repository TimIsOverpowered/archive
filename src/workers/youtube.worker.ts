import { wrapWorkerProcessor } from './utils/worker-wrapper.js';
import type { YoutubeUploadJob, YoutubeUploadResult } from './jobs/types.js';
import { getJobContext } from './utils/job-context.js';
import { processVodUpload, linkVodPartsAfterDelay } from './youtube/vod-upload-processor.js';
import { getEffectiveSplitDuration } from './youtube/validation.js';
import { processGameUpload } from './youtube/game-upload-processor.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import type { AppLogger } from '../utils/logger.js';
import { resetFailures } from '../utils/discord-alerts.js';
import { TenantConfig } from '../config/types.js';
import type { SourceType, UploadType } from '../types/platforms.js';
import type { Kysely } from 'kysely';
import type { StreamerDB } from '../db/streamer-types.js';
import { publishVodUpdate } from '../services/cache-invalidator.js';
import { ConfigNotConfiguredError } from '../utils/domain-errors.js';
import { saveUploadResult, markUploadFailed } from '../services/youtube/upload.js';
import type { Job } from 'bullmq';

interface YoutubeProcessorContext {
  log: AppLogger;
  tenantId: string;
  dbId: number;
  vodId: string;
  type: SourceType | UploadType;
  filePath: string;
  config: TenantConfig;
  db: Kysely<StreamerDB>;
  startTime: number;
  kind: 'vod' | 'game';
  dmcaProcessed?: boolean | undefined;
  part?: number | undefined;
  chapterStart?: number | undefined;
  chapterEnd?: number | undefined;
  chapterName?: string | undefined;
  chapterGameId?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
}

const buildYoutubeContext = async (job: Job<YoutubeUploadJob>): Promise<YoutubeProcessorContext> => {
  const { tenantId, dbId, vodId, type, filePath, kind } = job.data;
  const log = createAutoLogger(String(tenantId));
  const startTime = Date.now();

  let actualFilePath = filePath;

  if (actualFilePath == null || actualFilePath === '') {
    const childResults = await job.getChildrenValues();
    const firstResult = Object.values(childResults)[0] as { finalPath?: string; filePath?: string };

    if (firstResult?.filePath != null && firstResult.filePath !== '') {
      actualFilePath = firstResult.filePath;
      log.debug({ vodId, filePath: actualFilePath }, 'Retrieved filePath from game upload child result');
    } else if (firstResult?.finalPath != null && firstResult.finalPath !== '') {
      actualFilePath = firstResult.finalPath;
      log.debug({ vodId, filePath: actualFilePath }, 'Retrieved filePath from download job result');
    } else {
      throw new Error(
        `File path not available for vodId=${vodId}, jobId=${job.id}: child jobs may have failed or not completed`
      );
    }
  }

  const { config, db } = await getJobContext(tenantId);

  if (config == null || config.youtube == null) {
    throw new ConfigNotConfiguredError(`YouTube for tenant ${tenantId}`);
  }

  const base = {
    log,
    tenantId,
    dbId,
    vodId,
    type,
    filePath: actualFilePath,
    config,
    db,
    startTime,
    kind,
  };

  if (kind === 'game') {
    const { chapterStart, chapterEnd, chapterName, chapterGameId, title, description } = job.data;
    return {
      ...base,
      chapterStart,
      chapterEnd,
      chapterName,
      chapterGameId,
      title,
      description,
    };
  }

  const { dmcaProcessed, part } = job.data;
  return {
    ...base,
    dmcaProcessed,
    part,
  };
};

const errorMeta = (ctx: YoutubeProcessorContext, _job: Job) => ({
  vodId: ctx.vodId,
  tenantId: ctx.tenantId,
  dbId: ctx.dbId,
  jobId: _job.id,
  filePath: ctx.filePath,
});

const errorAlert = async (ctx: YoutubeProcessorContext, _job: Job, _errorMsg: string) => {
  await markUploadFailed(ctx.db, ctx.dbId, ctx.type);
  await publishVodUpdate(ctx.tenantId, ctx.dbId);
};

const youtubeProcessor = wrapWorkerProcessor(
  buildYoutubeContext,
  async (ctx) => {
    if (ctx.kind === 'vod') {
      const vodResult = await processVodUpload({
        tenantId: ctx.tenantId,
        dbId: ctx.dbId,
        vodId: ctx.vodId,
        filePath: ctx.filePath,
        db: ctx.db,
        config: ctx.config,
        dmcaProcessed: ctx.dmcaProcessed ?? false,
        log: ctx.log,
        type: ctx.type as SourceType,
        part: ctx.part,
      });

      await saveUploadResult(ctx.db, ctx.dbId, ctx.type, vodResult.uploadedVideos);
      await publishVodUpdate(ctx.tenantId, ctx.dbId);

      const splitDuration = getEffectiveSplitDuration(ctx.config.youtube?.splitDuration);
      linkVodPartsAfterDelay(ctx.tenantId, ctx.dbId, vodResult.uploadedVideos, splitDuration, ctx.db, ctx.log);

      const duration = Date.now() - ctx.startTime;
      ctx.log.info(
        { vodId: ctx.vodId, duration, uploadedVideosCount: vodResult.uploadedVideos?.length },
        'Job completed successfully'
      );

      return { success: true, videos: vodResult.uploadedVideos };
    } else {
      const result = await processGameUpload({
        tenantId: ctx.tenantId,
        dbId: ctx.dbId,
        vodId: ctx.vodId,
        filePath: ctx.filePath,
        chapterStart: ctx.chapterStart as number,
        chapterEnd: ctx.chapterEnd as number,
        chapterName: ctx.chapterName as string,
        chapterGameId: ctx.chapterGameId,
        title: ctx.title as string,
        description: ctx.description as string,
        db: ctx.db,
        config: ctx.config,
        log: ctx.log,
      });

      resetFailures(ctx.tenantId);
      const duration = Date.now() - ctx.startTime;
      ctx.log.info({ component: 'youtube-upload', vodId: ctx.vodId, duration }, 'Game upload completed successfully');
      return result;
    }
  },
  { errorMeta, errorAlert }
) as unknown as import('bullmq').Processor<YoutubeUploadJob, YoutubeUploadResult>;

export default youtubeProcessor;
