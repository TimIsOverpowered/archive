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

export const LIVE_JOB_ID_PREFIX = 'live_hls_';

export const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
};

export const queueRetryOptions: Record<string, QueueOptions['defaultJobOptions']> = {
  [QUEUE_NAMES.CHAT_DOWNLOAD]: { attempts: 5, backoff: { type: 'exponential' as const, delay: 3000 } },
  [QUEUE_NAMES.YOUTUBE_UPLOAD]: { attempts: 3, backoff: { type: 'exponential' as const, delay: 10000 } },
  [QUEUE_NAMES.DMCA_PROCESSING]: { attempts: 3, backoff: { type: 'exponential' as const, delay: 10000 } },
};

const queueCache = new Map<string, Queue<unknown, unknown, string>>();

/** Simple cache key for the queue options. Options are fixed literals, so no recursive sorting needed. */
function cacheKeyForOptions(options: QueueOptions['defaultJobOptions'] | undefined): string {
  return options ? JSON.stringify(options) : '';
}

let _flowProducer: FlowProducer | null = null;

export function getFlowProducer(): FlowProducer {
  _flowProducer ??= new FlowProducer({
    connection: getRedisInstance(),
  });
  return _flowProducer;
}

function getQueue<TData = unknown, TFinishedData = unknown>(
  name: string,
  jobOptions?: QueueOptions['defaultJobOptions']
): Queue<TData, TFinishedData, string> {
  const cacheKey = `${name}:${cacheKeyForOptions(jobOptions)}`;

  const cached = queueCache.get(cacheKey);
  if (cached) {
    return cached as Queue<TData, TFinishedData, string>;
  }

  const queue = new Queue<TData, TFinishedData, string>(name, {
    connection: getRedisInstance(),
    defaultJobOptions: jobOptions ?? defaultJobOptions,
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
  return getQueue(QUEUE_NAMES.CHAT_DOWNLOAD, queueRetryOptions[QUEUE_NAMES.CHAT_DOWNLOAD]);
}

export function getYoutubeUploadQueue(): Queue<YoutubeUploadJob, YoutubeUploadJob, string> {
  return getQueue(QUEUE_NAMES.YOUTUBE_UPLOAD, queueRetryOptions[QUEUE_NAMES.YOUTUBE_UPLOAD]);
}

export function getDmcaProcessingQueue(): Queue<DmcaProcessingJob, DmcaProcessingJob, string> {
  return getQueue(QUEUE_NAMES.DMCA_PROCESSING, queueRetryOptions[QUEUE_NAMES.DMCA_PROCESSING]);
}

export function getMonitorQueue(): Queue<MonitorJob, MonitorJob, string> {
  return getQueue(QUEUE_NAMES.MONITOR);
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
