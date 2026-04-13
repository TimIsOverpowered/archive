// workers/workerDefinitions.ts
import { Processor } from 'bullmq';
import liveProcessor from './live.worker.js';
import standardVodProcessor from './vod.worker.js';
import chatProcessor from './chat.worker.js';
import youtubeProcessor from './youtube.worker.js';
import dmcaProcessor from './dmca.worker.js';
import { ChatDownloadJob, ChatDownloadResult, DmcaProcessingJob, DmcaProcessingResult, QUEUE_NAMES, YoutubeUploadJob, YoutubeUploadResult, LiveDownloadJob, StandardVodJob } from './jobs/queues.js';
import { getWorkersConfig } from '../config/env.js';

export type WorkerName = 'vod_live' | 'vod_standard' | 'chat_download' | 'youtube_upload' | 'dmca_processing';
export type AllJobData = LiveDownloadJob | StandardVodJob | ChatDownloadJob | YoutubeUploadJob | DmcaProcessingJob;

export interface WorkerConfig<TData extends object = object, TResult = unknown> {
  name: WorkerName;
  queueName: string;
  processor: Processor<TData, TResult, string>;
  concurrency?: number;
}

function defineWorker<TData extends object, TResult>(def: WorkerConfig<TData, TResult>): WorkerConfig<object, unknown> {
  return def as WorkerConfig<object, unknown>;
}

export const WORKER_DEFINITIONS = [
  defineWorker<LiveDownloadJob, unknown>({
    name: 'vod_live',
    queueName: QUEUE_NAMES.VOD_LIVE,
    processor: liveProcessor,
    concurrency: getWorkersConfig().VOD_LIVE_CONCURRENCY,
  }),
  defineWorker<StandardVodJob, unknown>({
    name: 'vod_standard',
    queueName: QUEUE_NAMES.VOD_STANDARD,
    processor: standardVodProcessor,
    concurrency: getWorkersConfig().VOD_STANDARD_CONCURRENCY,
  }),
  defineWorker<ChatDownloadJob, ChatDownloadResult>({
    name: 'chat_download',
    queueName: QUEUE_NAMES.CHAT_DOWNLOAD,
    processor: chatProcessor,
    concurrency: 3,
  }),
  defineWorker<YoutubeUploadJob, YoutubeUploadResult>({
    name: 'youtube_upload',
    queueName: QUEUE_NAMES.YOUTUBE_UPLOAD,
    processor: youtubeProcessor,
    concurrency: getWorkersConfig().YOUTUBE_UPLOAD_CONCURRENCY,
  }),
  defineWorker<DmcaProcessingJob, DmcaProcessingResult>({
    name: 'dmca_processing',
    queueName: QUEUE_NAMES.DMCA_PROCESSING,
    processor: dmcaProcessor,
    concurrency: 1,
  }),
] as readonly WorkerConfig<object, unknown>[];
