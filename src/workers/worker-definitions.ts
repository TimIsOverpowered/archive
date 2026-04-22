import { Processor } from 'bullmq';
import liveProcessor from './live.worker.js';
import standardVodProcessor from './vod.worker.js';
import chatProcessor from './chat.worker.js';
import youtubeProcessor from './youtube.worker.js';
import dmcaProcessor from './dmca.worker.js';
import monitorProcessor from './monitor/processor.js';
import type {
  ChatDownloadJob,
  ChatDownloadResult,
  DmcaProcessingJob,
  DmcaProcessingResult,
  LiveDownloadJob,
  MonitorJob,
  StandardVodJob,
  YoutubeUploadJob,
  YoutubeUploadResult,
} from './jobs/queues.js';
import { QUEUE_NAMES } from './jobs/queues.js';
import { getWorkersConfig } from '../config/env.js';

export type WorkerName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
export type AllJobData = StandardVodJob | ChatDownloadJob | YoutubeUploadJob | DmcaProcessingJob | MonitorJob;

export interface WorkerConfig<TData extends object = object, TResult = unknown> {
  name: WorkerName;
  queueName: string;
  processor: Processor<TData, TResult, string>;
  concurrency?: number;
  useWorkerThreads?: boolean;
}

export type AnyWorkerConfig =
  | WorkerConfig<LiveDownloadJob, unknown>
  | WorkerConfig<StandardVodJob, unknown>
  | WorkerConfig<ChatDownloadJob, ChatDownloadResult>
  | WorkerConfig<YoutubeUploadJob, YoutubeUploadResult>
  | WorkerConfig<DmcaProcessingJob, DmcaProcessingResult>
  | WorkerConfig<MonitorJob, unknown>;

export function getWorkerDefinitions(): readonly AnyWorkerConfig[] {
  const config = getWorkersConfig();

  return [
    {
      name: QUEUE_NAMES.VOD_LIVE,
      queueName: QUEUE_NAMES.VOD_LIVE,
      processor: liveProcessor,
      useWorkerThreads: true,
    },
    {
      name: QUEUE_NAMES.VOD_STANDARD,
      queueName: QUEUE_NAMES.VOD_STANDARD,
      processor: standardVodProcessor,
      concurrency: config.VOD_STANDARD_CONCURRENCY,
      useWorkerThreads: true,
    },
    {
      name: QUEUE_NAMES.CHAT_DOWNLOAD,
      queueName: QUEUE_NAMES.CHAT_DOWNLOAD,
      processor: chatProcessor,
      concurrency: config.CHAT_DOWNLOAD_CONCURRENCY,
      useWorkerThreads: true,
    },
    {
      name: QUEUE_NAMES.YOUTUBE_UPLOAD,
      queueName: QUEUE_NAMES.YOUTUBE_UPLOAD,
      processor: youtubeProcessor,
      concurrency: config.YOUTUBE_UPLOAD_CONCURRENCY,
      useWorkerThreads: true,
    },
    {
      name: QUEUE_NAMES.DMCA_PROCESSING,
      queueName: QUEUE_NAMES.DMCA_PROCESSING,
      processor: dmcaProcessor,
      concurrency: 1,
      useWorkerThreads: true,
    },
    {
      name: QUEUE_NAMES.MONITOR,
      queueName: QUEUE_NAMES.MONITOR,
      processor: monitorProcessor,
      concurrency: config.MONITOR_CONCURRENCY,
      useWorkerThreads: true,
    },
  ] as const;
}
