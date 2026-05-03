import { Queue, QueueOptions, FlowProducer } from 'bullmq';
import type {
  LiveDownloadJob,
  StandardVodJob,
  ChatDownloadJob,
  YoutubeUploadJob,
  DmcaProcessingJob,
  MonitorJob,
} from '../jobs/types.js';
import { getRedisInstance } from '../redis.js';

export const QUEUE_NAMES = {
  VOD_LIVE: 'vod_live',
  VOD_STANDARD: 'vod_standard',
  CHAT_DOWNLOAD: 'chat_download',
  YOUTUBE_UPLOAD: 'youtube_upload',
  DMCA_PROCESSING: 'dmca_processing',
  MONITOR: 'monitor',
} as const;

export type WorkerName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const LIVE_JOB_ID_PREFIX = 'live_hls_';

type JobOpts = NonNullable<QueueOptions['defaultJobOptions']>;

export const defaultJobOptions: JobOpts = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
};

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

export function getLiveDownloadQueue(): Queue<LiveDownloadJob, LiveDownloadJob, string> {
  return getQueue(QUEUE_NAMES.VOD_LIVE, defaultJobOptions);
}

export function getStandardVodQueue(): Queue<StandardVodJob, StandardVodJob, string> {
  return getQueue(QUEUE_NAMES.VOD_STANDARD, defaultJobOptions);
}

export function getChatDownloadQueue(): Queue<ChatDownloadJob, ChatDownloadJob, string> {
  return getQueue(QUEUE_NAMES.CHAT_DOWNLOAD, { attempts: 5, backoff: { type: 'exponential' as const, delay: 3000 } });
}

export function getYoutubeUploadQueue(): Queue<YoutubeUploadJob, YoutubeUploadJob, string> {
  return getQueue(QUEUE_NAMES.YOUTUBE_UPLOAD, { attempts: 3, backoff: { type: 'exponential' as const, delay: 10000 } });
}

export function getDmcaProcessingQueue(): Queue<DmcaProcessingJob, DmcaProcessingJob, string> {
  return getQueue(QUEUE_NAMES.DMCA_PROCESSING, {
    attempts: 3,
    backoff: { type: 'exponential' as const, delay: 10000 },
  });
}

export function getMonitorQueue(): Queue<MonitorJob, MonitorJob, string> {
  return getQueue(QUEUE_NAMES.MONITOR, defaultJobOptions);
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
