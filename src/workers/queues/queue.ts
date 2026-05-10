import { Queue, QueueOptions, FlowProducer } from 'bullmq';
import type {
  LiveDownloadJob,
  LiveDownloadResult,
  StandardVodJob,
  StandardVodResult,
  ChatDownloadJob,
  ChatDownloadResult,
  YoutubeUploadJob,
  YoutubeUploadResult,
  VodFinalizeFileJob,
  VodFinalizeFileResult,
  DmcaProcessingJob,
  DmcaProcessingResult,
  MonitorJob,
  MonitorJobResult,
  CopyFileJob,
  CopyFileResult,
} from '../jobs/types.js';
import { getRedisInstance } from '../redis.js';

export const QUEUE_NAMES = {
  VOD_LIVE: 'vod_live',
  VOD_STANDARD: 'vod_standard',
  CHAT_DOWNLOAD: 'chat_download',
  YOUTUBE_UPLOAD: 'youtube_upload',
  VOD_FINALIZE_FILE: 'vod_finalize_file',
  DMCA_PROCESSING: 'dmca_processing',
  MONITOR: 'monitor',
  FILE_COPY: 'file_copy',
} as const;

export type WorkerName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

type JobOpts = NonNullable<QueueOptions['defaultJobOptions']>;

export const defaultJobOptions: JobOpts = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
};

function exponentialBackoff(delay: number, attempts: number): JobOpts {
  return { attempts, backoff: { type: 'exponential' as const, delay } };
}

const queueCache = new Map<string, Queue<unknown, unknown, string>>();

let _flowProducer: FlowProducer | null = null;

export function getFlowProducer(): FlowProducer {
  _flowProducer ??= new FlowProducer({
    connection: getRedisInstance(),
  });
  return _flowProducer;
}

function getQueue<TData = unknown, TFinishedData = unknown>(
  name: string,
  jobOptions: JobOpts
): Queue<TData, TFinishedData, string> {
  const cached = queueCache.get(name);
  if (cached) {
    return cached as Queue<TData, TFinishedData, string>;
  }

  const queue = new Queue<TData, TFinishedData, string>(name, {
    connection: getRedisInstance(),
    defaultJobOptions: jobOptions,
  });

  queueCache.set(name, queue);
  return queue;
}

export function getLiveDownloadQueue(): Queue<LiveDownloadJob, LiveDownloadResult, string> {
  return getQueue(QUEUE_NAMES.VOD_LIVE, defaultJobOptions);
}

export function getStandardVodQueue(): Queue<StandardVodJob, StandardVodResult, string> {
  return getQueue(QUEUE_NAMES.VOD_STANDARD, defaultJobOptions);
}

export function getChatDownloadQueue(): Queue<ChatDownloadJob, ChatDownloadResult, string> {
  return getQueue(QUEUE_NAMES.CHAT_DOWNLOAD, exponentialBackoff(3000, 5));
}

export function getYoutubeUploadQueue(): Queue<YoutubeUploadJob, YoutubeUploadResult, string> {
  return getQueue(QUEUE_NAMES.YOUTUBE_UPLOAD, exponentialBackoff(10_000, 3));
}

export function getVodFinalizeFileQueue(): Queue<VodFinalizeFileJob, VodFinalizeFileResult, string> {
  return getQueue(QUEUE_NAMES.VOD_FINALIZE_FILE, exponentialBackoff(5_000, 3));
}

export function getDmcaProcessingQueue(): Queue<DmcaProcessingJob, DmcaProcessingResult, string> {
  return getQueue(QUEUE_NAMES.DMCA_PROCESSING, exponentialBackoff(10_000, 3));
}

export function getMonitorQueue(): Queue<MonitorJob, MonitorJobResult, string> {
  return getQueue(QUEUE_NAMES.MONITOR, defaultJobOptions);
}

export function getFileCopyQueue(): Queue<CopyFileJob, CopyFileResult, string> {
  return getQueue(QUEUE_NAMES.FILE_COPY, exponentialBackoff(5_000, 3));
}

export async function closeQueues(): Promise<void> {
  for (const queue of queueCache.values()) {
    await queue.close();
  }
  queueCache.clear();
  if (_flowProducer != null) {
    await _flowProducer.close();
    _flowProducer = null;
  }
  // Don't quit redis here - it's managed by workers/redis.ts
  // The redis instance is shared and should only be closed during worker shutdown
}
