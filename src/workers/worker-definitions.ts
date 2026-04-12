// workers/workerDefinitions.ts
import liveProcessor from './live.worker.js';
import standardVodProcessor from './vod.worker.js';
import chatProcessor from './chat.worker.js';
import youtubeProcessor from './youtube.worker.js';
import dmcaProcessor from './dmca.worker.js';
import { ChatDownloadJob, ChatDownloadResult, DmcaProcessingJob, DmcaProcessingResult, QUEUE_NAMES, YoutubeUploadJob, YoutubeUploadResult, LiveDownloadJob, StandardVodJob } from './jobs/queues.js';
import { Job } from 'bullmq';

export type WorkerName = 'vod_live' | 'vod_standard' | 'chat_download' | 'youtube_upload' | 'dmca_processing';
export type AllJobData = LiveDownloadJob | StandardVodJob | ChatDownloadJob | YoutubeUploadJob | DmcaProcessingJob;

export interface WorkerConfig<TData, TResult> {
  name: WorkerName;
  queueName: string;
  processor: (job: Job<TData>) => Promise<TResult>;
  concurrency?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyWorkerConfig = WorkerConfig<any, any>;

function defineWorker<TData extends object, TResult>(def: WorkerConfig<TData, TResult>): AnyWorkerConfig {
  return def;
}

export const WORKER_DEFINITIONS = [
  defineWorker<LiveDownloadJob, unknown>({
    name: 'vod_live',
    queueName: QUEUE_NAMES.VOD_LIVE,
    processor: liveProcessor,
    concurrency: 50,
  }),
  defineWorker<StandardVodJob, unknown>({
    name: 'vod_standard',
    queueName: QUEUE_NAMES.VOD_STANDARD,
    processor: standardVodProcessor,
    concurrency: 10,
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
    concurrency: 3,
  }),
  defineWorker<DmcaProcessingJob, DmcaProcessingResult>({
    name: 'dmca_processing',
    queueName: QUEUE_NAMES.DMCA_PROCESSING,
    processor: dmcaProcessor,
    concurrency: 1,
  }),
] satisfies ReadonlyArray<WorkerConfig<object, unknown>>;
