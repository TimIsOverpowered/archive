import { Queue, QueueOptions, JobsOptions } from 'bullmq';
import type { DMCAClaim } from '../../utils/dmca.js';
import { redisInstance } from '../redis.js';

export interface LiveDownloadJob {
  dbId: number;
  vodId: string;
  platform: 'twitch' | 'kick';
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
  platform: 'twitch' | 'kick';
  downloadMethod?: 'ffmpeg' | 'hls';
  uploadMode?: 'vod' | 'all';
}

export interface ChatDownloadJob {
  tenantId: string;
  platformUserId?: string;
  platformUsername?: string;
  dbId: number;
  vodId: string;
  platform: 'twitch' | 'kick';
  duration: number;
  startOffset?: number;
}

export interface YoutubeVodUploadJob {
  tenantId: string;
  dbId: number;
  vodId: string;
  filePath: string;
  type: 'vod';
  platform: 'twitch' | 'kick';
  dmcaProcessed?: boolean;
}

export interface YoutubeGameUploadJob {
  tenantId: string;
  dbId: number;
  vodId: string;
  filePath: string;
  type: 'game';
  platform: 'twitch' | 'kick';
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
  type: 'vod' | 'live';
  platform: 'twitch' | 'kick';
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
};

export const youtubeJobOptions = {
  ...defaultJobOptions,
  attempts: 5,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const queueCache = new Map<string, Queue<any, any, string>>();

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
  return getQueue(QUEUE_NAMES.DMCA_PROCESSING);
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
  // Don't quit redis here - it's managed by workers/redis.ts
  // The redis instance is shared and should only be closed during worker shutdown
}
