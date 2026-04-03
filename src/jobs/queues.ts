import { Queue, QueueOptions, JobsOptions } from 'bullmq';
import type { DMCAClaim } from '../utils/dmca.js';
import { redisInstance } from '../workers/redis.js';

export type VodJobType = 'STANDARD_VOD_DOWNLOAD' | 'LIVE_HLS_DOWNLOAD';

export interface VODDownloadJob {
  tenantId: string;
  platformUserId: string;
  platformUsername?: string;
  vodId: string;
  platform: 'twitch' | 'kick';
  externalVodId?: string;
}

export interface LiveHlsDownloadJob {
  vodId: string;
  platform: 'twitch' | 'kick';
  tenantId: string;
  platformUserId: string;
  platformUsername?: string;
  startedAt?: string; // ISO timestamp when live stream was detected
  sourceUrl?: string; // Kick HLS URL (passed from monitor)
  isFallback?: boolean; // Flag for Twitch fallback mode (no VOD object found)
}

export interface ChatDownloadJob {
  tenantId: string;
  platformUserId: string;
  platformUsername?: string;
  vodId: string;
  platform: 'twitch' | 'kick';
  duration: number;
  vodStartDate?: string;
  startOffset?: number; // Resume from this offset (in seconds) when regenerating chat
}

export interface YoutubeUploadJob {
  streamerId: string;
  vodId: string;
  filePath: string;
  title: string;
  description: string;
  type: 'vod' | 'game';
  platform?: 'twitch' | 'kick';
  part?: number;
  chapter?: {
    name: string;
    start: number;
    end: number;
    gameId?: string;
  };
  dmcaProcessed?: boolean;
}

export interface DmcaProcessingJob {
  streamerId: string;
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
  gameId?: number;
}

export interface YoutubeUploadSplitGamesResult {
  success: true;
  videos: Array<{ id: string; part: number; startTime: number; endTime: number; gameId?: number }>;
}

export interface YoutubeUploadSkippedResult {
  success: true;
  skipped: boolean;
}

export type YoutubeUploadResult = YoutubeUploadVodResult | YoutubeUploadGameResult | YoutubeUploadSplitGamesResult | YoutubeUploadSkippedResult;

export interface DmcaProcessingSuccessResult {
  success: true;
  youtubeJobId?: string;
  vodId?: string;
  message?: string;
}

export type DmcaProcessingResult = DmcaProcessingSuccessResult;

export const QUEUE_NAMES = {
  VOD_DOWNLOAD: 'vod_download',
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

export function getVODDownloadQueue(): Queue<VODDownloadJob, VODDownloadJob, string> {
  return getQueue(QUEUE_NAMES.VOD_DOWNLOAD);
}

export function getLiveHlsDownloadQueue(): Queue<LiveHlsDownloadJob, LiveHlsDownloadJob, string> {
  return getQueue(QUEUE_NAMES.VOD_DOWNLOAD) as unknown as Queue<LiveHlsDownloadJob, LiveHlsDownloadJob, string>;
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
    logger.info(context, `Job already exists in state ${state}, skipping`);
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
