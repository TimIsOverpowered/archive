import { Queue, QueueOptions, JobsOptions, FlowProducer } from 'bullmq';
import type { DMCAClaim } from '../dmca/dmca.js';
import { getRedisInstance } from '../redis.js';
import type { Platform, SourceType, UploadType, DownloadMethod } from '../../types/platforms.js';
import { VodRecord } from '../../types/db.js';

export interface LiveDownloadJob {
  dbId: number;
  vodId: string;
  platform: Platform;
  tenantId: string;
  platformUserId: string;
  platformUsername?: string | undefined;
  startedAt?: string | undefined;
  sourceUrl?: string | undefined;
}

export interface StandardVodJob {
  tenantId: string;
  dbId: number;
  vodId: string;
  platform: Platform;
  platformUserId: string;
  platformUsername: string;
  sourceUrl?: string | undefined;
  downloadMethod?: DownloadMethod | undefined;
}

export interface ChatDownloadJob {
  tenantId: string;
  platformUserId?: string | undefined;
  platformUsername?: string | undefined;
  dbId: number;
  vodId: string;
  platform: Platform;
  duration: number;
  startOffset?: number | undefined;
  forceRerun?: boolean | undefined;
}

export interface YoutubeVodUploadJob {
  tenantId: string;
  dbId: number;
  vodId: string;
  filePath?: string | undefined;
  type: SourceType;
  platform: Platform;
  dmcaProcessed?: boolean | undefined;
  vodRecord: VodRecord;
  part?: number | undefined;
}

export interface YoutubeGameUploadJob {
  tenantId: string;
  dbId: number;
  vodId: string;
  filePath?: string | undefined;
  type: UploadType;
  platform: Platform;
  chapterId: number;
  chapterName: string;
  chapterStart: number;
  chapterEnd: number;
  chapterGameId?: string | undefined;
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
  part?: number | undefined;
  filePath?: string | undefined;
}

export interface MonitorJob {
  tenantId: string;
}

export interface ChatDownloadResult {
  success: true;
  totalMessages?: number;
  batchCount?: number;
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

export type YoutubeUploadResult =
  | YoutubeUploadVodResult
  | YoutubeUploadGameResult
  | YoutubeUploadSplitGameResult
  | YoutubeUploadSkippedResult;

export interface DmcaProcessingSuccessResult {
  success: true;
  youtubeJobId?: string;
  vodId?: string;
  message?: string;
}

export type DmcaProcessingResult = DmcaProcessingSuccessResult;

export type QueueJob =
  | LiveDownloadJob
  | StandardVodJob
  | ChatDownloadJob
  | YoutubeUploadJob
  | DmcaProcessingJob
  | MonitorJob;

export const QUEUE_NAMES = {
  VOD_LIVE: 'vod_live',
  VOD_STANDARD: 'vod_standard',
  CHAT_DOWNLOAD: 'chat_download',
  YOUTUBE_UPLOAD: 'youtube_upload',
  DMCA_PROCESSING: 'dmca_processing',
  MONITOR: 'monitor',
} as const;

export const QUEUES_VALUES = Object.values(QUEUE_NAMES);

export const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: true,
  removeOnFail: true,
};

const queueCache = new Map<string, Queue<QueueJob, QueueJob, string>>();

function normalizeOptions(options: unknown): string {
  if (!options) return '';
  try {
    return JSON.stringify(options, Object.keys(options as Record<string, unknown>).sort());
  } catch {
    return JSON.stringify(options);
  }
}

let _flowProducer: FlowProducer | null = null;

export function getFlowProducer(): FlowProducer {
  if (!_flowProducer) {
    _flowProducer = new FlowProducer({
      connection: getRedisInstance(),
    });
  }
  return _flowProducer;
}

export function getQueue<TData = unknown, TFinishedData = unknown>(
  name: string,
  jobOptions?: QueueOptions['defaultJobOptions']
): Queue<TData, TFinishedData, string> {
  const cacheKey = `${name}:${normalizeOptions(jobOptions)}`;

  if (queueCache.has(cacheKey)) {
    return queueCache.get(cacheKey)! as Queue<TData, TFinishedData, string>;
  }

  const queue = new Queue<TData, TFinishedData, string>(name, {
    connection: getRedisInstance(),
    defaultJobOptions: jobOptions || defaultJobOptions,
  });

  queueCache.set(cacheKey, queue as Queue<QueueJob, QueueJob, string>);
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
  return getQueue(QUEUE_NAMES.YOUTUBE_UPLOAD);
}

export function getDmcaProcessingQueue(): Queue<DmcaProcessingJob, DmcaProcessingJob, string> {
  return getQueue(QUEUE_NAMES.DMCA_PROCESSING);
}

export function getMonitorQueue(): Queue<MonitorJob, MonitorJob, string> {
  return getQueue(QUEUE_NAMES.MONITOR);
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
  await getFlowProducer().close();
  // Don't quit redis here - it's managed by workers/redis.ts
  // The redis instance is shared and should only be closed during worker shutdown
}
