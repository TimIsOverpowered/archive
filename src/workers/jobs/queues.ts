import { Queue, QueueOptions, JobsOptions, FlowProducer } from 'bullmq';
import type { DMCAClaim } from '../../utils/dmca.js';
import { redisInstance } from '../redis.js';
import type { Platform, SourceType, UploadType, DownloadMethod } from '../../types/platforms.js';
import { VodRecord } from '../../types/db.js';

export interface LiveDownloadJob {
  dbId: number;
  vodId: string;
  platform: Platform;
  tenantId: string;
  platformUserId: string;
  platformUsername?: string;
  startedAt?: string;
  sourceUrl?: string;
}

export interface StandardVodJob {
  tenantId: string;
  dbId: number;
  vodId: string;
  platform: Platform;
  downloadMethod?: DownloadMethod;
}

export interface ChatDownloadJob {
  tenantId: string;
  platformUserId?: string;
  platformUsername?: string;
  dbId: number;
  vodId: string;
  platform: Platform;
  duration: number;
  startOffset?: number;
}

export interface YoutubeVodUploadJob {
  tenantId: string;
  dbId: number;
  vodId: string;
  filePath?: string;
  type: UploadType;
  platform: Platform;
  dmcaProcessed?: boolean;
  vodRecord: VodRecord;
}

export interface YoutubeGameUploadJob {
  tenantId: string;
  dbId: number;
  vodId: string;
  filePath?: string;
  type: UploadType;
  platform: Platform;
  chapterId: number;
  chapterName: string;
  chapterStart: number;
  chapterEnd: number;
  chapterGameId?: string;
  title: string;
  description: string;
}

export type YoutubeUploadJob = YoutubeVodUploadJob | YoutubeGameUploadJob;

export interface DmcaProcessingJob {
  tenantId: string;
  dbId: number;
  vodId: string;
  receivedClaims: DMCAClaim[];
  type: SourceType;
  platform: Platform;
  part?: number;
}

export interface ChatDownloadResult {
  success: true;
  totalMessages?: number;
  skipped?: boolean;
}

export interface YoutubeUploadVodResult {
  success: true;
  videos: Array<{ id: string; part: number }>;
}

export interface YoutubeUploadGameResult {
  success: true;
  videoId: string;
  gameId: string;
}

export interface YoutubeUploadSplitGameResult {
  success: true;
  videos: Array<{ id: string; part: number; startTime: number; endTime: number; gameId: string }>;
}

export interface YoutubeUploadSkippedResult {
  success: true;
  skipped: boolean;
}

export type YoutubeUploadResult = YoutubeUploadVodResult | YoutubeUploadGameResult | YoutubeUploadSplitGameResult | YoutubeUploadSkippedResult;

export interface DmcaProcessingSuccessResult {
  success: true;
  youtubeJobId?: string;
  vodId?: string;
  message?: string;
}

export type DmcaProcessingResult = DmcaProcessingSuccessResult;

export const QUEUE_NAMES = {
  VOD_LIVE: 'vod_live',
  VOD_STANDARD: 'vod_standard',
  CHAT_DOWNLOAD: 'chat_download',
  YOUTUBE_UPLOAD: 'youtube_upload',
  DMCA_PROCESSING: 'dmca_processing',
} as const;

export const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: true,
  removeOnFail: true,
};

export const youtubeJobOptions = {
  ...defaultJobOptions,
  attempts: 5,
};

export const dmcaJobOptions = {
  attempts: 60,
  backoff: {
    type: 'fixed' as const,
    delay: 10 * 60 * 1000,
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const queueCache = new Map<string, Queue<any, any, string>>();

export const flowProducer = new FlowProducer({
  connection: redisInstance,
});

export function getQueue<TData = unknown, TFinishedData = unknown>(name: string, jobOptions?: QueueOptions['defaultJobOptions']): Queue<TData, TFinishedData, string> {
  const cacheKey = `${name}:${JSON.stringify(jobOptions)}`;

  if (queueCache.has(cacheKey)) {
    return queueCache.get(cacheKey)! as Queue<TData, TFinishedData, string>;
  }

  const queue = new Queue<TData, TFinishedData, string>(name, {
    connection: redisInstance,
    defaultJobOptions: jobOptions || defaultJobOptions,
  });

  queueCache.set(cacheKey, queue);
  return queue;
}

export function getLiveDownloadQueue(): Queue<LiveDownloadJob, LiveDownloadJob, string> {
  return getQueue(QUEUE_NAMES.VOD_LIVE);
}

export function getStandardVodQueue(): Queue<StandardVodJob, StandardVodJob, string> {
  return getQueue(QUEUE_NAMES.VOD_STANDARD);
}

export function getChatDownloadQueue(): Queue<ChatDownloadJob, ChatDownloadJob, string> {
  return getQueue(QUEUE_NAMES.CHAT_DOWNLOAD);
}

export function getYoutubeUploadQueue(): Queue<YoutubeUploadJob, YoutubeUploadJob, string> {
  return getQueue(QUEUE_NAMES.YOUTUBE_UPLOAD, youtubeJobOptions);
}

export function getDmcaProcessingQueue(): Queue<DmcaProcessingJob, DmcaProcessingJob, string> {
  return getQueue(QUEUE_NAMES.DMCA_PROCESSING, dmcaJobOptions);
}

export interface JobLogger {
  info: (context: Record<string, unknown>, message: string) => void;
  debug: (context: Record<string, unknown>, message: string) => void;
}

export interface JobEnqueueResult {
  jobId: string;
  isNew: boolean;
}

export async function enqueueJobWithLogging(
  queue: Queue<unknown, unknown, string>,
  name: string,
  data: unknown,
  options: JobsOptions,
  logger: JobLogger,
  successMessage: string,
  extraContext?: Record<string, unknown>
): Promise<JobEnqueueResult> {
  const job = await queue.add(name, data, options);
  const state = await job.getState();
  const context = { jobId: String(job.id), state, ...extraContext };

  if (state === 'active' || state === 'completed' || state === 'failed') {
    logger.debug(context, `Job already exists in state ${state}, skipping`);
    return { jobId: String(job.id), isNew: false };
  } else {
    logger.info(context, successMessage);
    return { jobId: String(job.id), isNew: true };
  }
}

export async function closeQueues(): Promise<void> {
  for (const queue of queueCache.values()) {
    await queue.close();
  }
  queueCache.clear();
  await flowProducer.close();
  // Don't quit redis here - it's managed by workers/redis.ts
  // The redis instance is shared and should only be closed during worker shutdown
}
