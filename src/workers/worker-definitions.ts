import { Processor } from 'bullmq';
import liveProcessor from './live.worker.js';
import standardVodProcessor from './vod.worker.js';
import chatProcessor from './chat.worker.js';
import youtubeProcessor from './youtube.worker.js';
import dmcaProcessor from './dmca.worker.js';
import monitorProcessor from './monitor/processor.js';
import {
  ChatDownloadJob,
  ChatDownloadResult,
  DmcaProcessingJob,
  DmcaProcessingResult,
  QUEUE_NAMES,
  YoutubeUploadJob,
  YoutubeUploadResult,
  LiveDownloadJob,
  StandardVodJob,
  MonitorJob,
} from './jobs/queues.js';
import { getWorkersConfig } from '../config/env.js';

export type WorkerName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
export type AllJobData = StandardVodJob | ChatDownloadJob | YoutubeUploadJob | DmcaProcessingJob | MonitorJob;

export interface WorkerConfig<TData extends object = object, TResult = unknown> {
  name: WorkerName;
  queueName: string;
  processor: Processor<TData, TResult, string>;
  concurrency?: number | undefined;
  useWorkerThreads?: boolean | undefined;
}

export function defineWorker<TData extends object = object, TResult = unknown>(
  def: WorkerConfig<TData, TResult>
): WorkerConfig<TData, TResult> {
  return def;
}

export const WORKER_DEFINITIONS = [
  defineWorker<LiveDownloadJob, unknown>({
    name: 'vod_live',
    queueName: QUEUE_NAMES.VOD_LIVE,
    processor: liveProcessor,
    concurrency: undefined,
    useWorkerThreads: true,
  }),
  defineWorker<StandardVodJob, unknown>({
    name: 'vod_standard',
    queueName: QUEUE_NAMES.VOD_STANDARD,
    processor: standardVodProcessor,
    concurrency: getWorkersConfig().VOD_STANDARD_CONCURRENCY,
    useWorkerThreads: true,
  }),
  defineWorker<ChatDownloadJob, ChatDownloadResult>({
    name: 'chat_download',
    queueName: QUEUE_NAMES.CHAT_DOWNLOAD,
    processor: chatProcessor,
    concurrency: getWorkersConfig().CHAT_DOWNLOAD_CONCURRENCY,
    useWorkerThreads: true,
  }),
  defineWorker<YoutubeUploadJob, YoutubeUploadResult>({
    name: 'youtube_upload',
    queueName: QUEUE_NAMES.YOUTUBE_UPLOAD,
    processor: youtubeProcessor,
    concurrency: getWorkersConfig().YOUTUBE_UPLOAD_CONCURRENCY,
    useWorkerThreads: true,
  }),
  defineWorker<DmcaProcessingJob, DmcaProcessingResult>({
    name: 'dmca_processing',
    queueName: QUEUE_NAMES.DMCA_PROCESSING,
    processor: dmcaProcessor,
    concurrency: 1,
    useWorkerThreads: true,
  }),
  defineWorker<MonitorJob, unknown>({
    name: 'monitor',
    queueName: QUEUE_NAMES.MONITOR,
    processor: monitorProcessor,
    concurrency: getWorkersConfig().MONITOR_CONCURRENCY,
    useWorkerThreads: true,
  }),
] as readonly WorkerConfig<object, unknown>[];
