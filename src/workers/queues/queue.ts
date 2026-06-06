import { Queue, QueueOptions, FlowProducer, ConnectionOptions } from 'bullmq';
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
  HlsConvertJob,
  HlsConvertResult,
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
  HLS_CONVERT: 'hls_convert',
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

/**
 * Manages queue and flow producer instances with a centralized cache.
 * Mirrors the WorkerRegistry pattern for testability — call close() to
 * reset state between test cases without module reloading.
 */
export class QueueRegistry {
  private cache = new Map<string, Queue<unknown, unknown, string>>();
  private flowProducer: FlowProducer | null = null;

  getQueue<TData = unknown, TFinishedData = unknown>(
    name: string,
    jobOptions: JobOpts
  ): Queue<TData, TFinishedData, string> {
    const cached = this.cache.get(name);
    if (cached) {
      return cached as unknown as Queue<TData, TFinishedData, string>;
    }

    const queue = new Queue(name, {
      connection: getRedisInstance() as unknown as ConnectionOptions,
      defaultJobOptions: jobOptions,
    }) as unknown as Queue<TData, TFinishedData, string>;

    this.cache.set(name, queue);
    return queue;
  }

  getFlowProducer(): FlowProducer {
    this.flowProducer ??= new FlowProducer({
      connection: getRedisInstance() as unknown as ConnectionOptions,
    });
    return this.flowProducer;
  }

  async close(): Promise<void> {
    for (const queue of this.cache.values()) {
      await queue.close();
    }
    this.cache.clear();
    if (this.flowProducer != null) {
      await this.flowProducer.close();
      this.flowProducer = null;
    }
  }
}

export const queueRegistry = new QueueRegistry();

export function getFlowProducer(): FlowProducer {
  return queueRegistry.getFlowProducer();
}

function getQueue<TData = unknown, TFinishedData = unknown>(
  name: string,
  jobOptions: JobOpts
): Queue<TData, TFinishedData, string> {
  return queueRegistry.getQueue(name, jobOptions);
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

export function getHlsConvertQueue(): Queue<HlsConvertJob, HlsConvertResult, string> {
  return getQueue(QUEUE_NAMES.HLS_CONVERT, exponentialBackoff(5_000, 3));
}

export async function closeQueues(): Promise<void> {
  return queueRegistry.close();
}
