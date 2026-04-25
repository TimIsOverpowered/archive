import { Processor } from 'bullmq';
import liveProcessor from './live.worker.js';
import standardVodProcessor from './vod.worker.js';
import chatProcessor from './chat.worker.js';
import youtubeProcessor from './youtube.worker.js';
import dmcaProcessor from './dmca.worker.js';
import monitorProcessor from './monitor/processor.js';
import { QUEUE_NAMES } from './queues/queue.js';
import type {
  LiveDownloadJob,
  StandardVodJob,
  ChatDownloadJob,
  YoutubeUploadJob,
  DmcaProcessingJob,
  MonitorJob,
  ChatDownloadResult,
  YoutubeUploadResult,
  DmcaProcessingResult,
} from './jobs/types.js';
import type { Redis } from 'ioredis';
import type { TenantConfig } from '../config/types.js';
import { getWorkersConfig } from '../config/env.js';
import { createWorker } from './create-worker.js';

export type WorkerName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
export type AllJobData =
  | LiveDownloadJob
  | StandardVodJob
  | ChatDownloadJob
  | YoutubeUploadJob
  | DmcaProcessingJob
  | MonitorJob;

// Typed per-worker definition — no type erasure here
interface WorkerDef<TData, TResult = unknown> {
  name: WorkerName;
  processor: Processor<TData, TResult, string>;
  concurrency?: number;
  useWorkerThreads?: boolean;
}

const workerDefs = {
  [QUEUE_NAMES.VOD_LIVE]: {
    name: QUEUE_NAMES.VOD_LIVE,
    processor: liveProcessor,
    useWorkerThreads: true,
  } satisfies WorkerDef<LiveDownloadJob>,

  [QUEUE_NAMES.VOD_STANDARD]: {
    name: QUEUE_NAMES.VOD_STANDARD,
    processor: standardVodProcessor,
    useWorkerThreads: true,
  } satisfies WorkerDef<StandardVodJob>,

  [QUEUE_NAMES.CHAT_DOWNLOAD]: {
    name: QUEUE_NAMES.CHAT_DOWNLOAD,
    processor: chatProcessor,
    useWorkerThreads: true,
  } satisfies WorkerDef<ChatDownloadJob, ChatDownloadResult>,

  [QUEUE_NAMES.YOUTUBE_UPLOAD]: {
    name: QUEUE_NAMES.YOUTUBE_UPLOAD,
    processor: youtubeProcessor,
    useWorkerThreads: true,
  } satisfies WorkerDef<YoutubeUploadJob, YoutubeUploadResult>,

  [QUEUE_NAMES.DMCA_PROCESSING]: {
    name: QUEUE_NAMES.DMCA_PROCESSING,
    processor: dmcaProcessor,
    useWorkerThreads: true,
  } satisfies WorkerDef<DmcaProcessingJob, DmcaProcessingResult>,

  [QUEUE_NAMES.MONITOR]: {
    name: QUEUE_NAMES.MONITOR,
    processor: monitorProcessor,
    useWorkerThreads: true,
  } satisfies WorkerDef<MonitorJob>,
};

export function registerWorkers(
  connection: Redis,
  tenantConfigs: TenantConfig[],
  vodLiveHeadroom: number,
  vodMinConcurrency: number
): void {
  const workerConfig = getWorkersConfig();

  const concurrencyMap: Partial<Record<WorkerName, number>> = {
    [QUEUE_NAMES.VOD_STANDARD]: workerConfig.VOD_STANDARD_CONCURRENCY,
    [QUEUE_NAMES.CHAT_DOWNLOAD]: workerConfig.CHAT_DOWNLOAD_CONCURRENCY,
    [QUEUE_NAMES.YOUTUBE_UPLOAD]: workerConfig.YOUTUBE_UPLOAD_CONCURRENCY,
    [QUEUE_NAMES.MONITOR]: workerConfig.MONITOR_CONCURRENCY,
  };

  for (const [name, def] of Object.entries(workerDefs) as Array<[WorkerName, WorkerDef<AllJobData, unknown>]>) {
    const concurrency =
      name === QUEUE_NAMES.VOD_LIVE
        ? Math.max(
            tenantConfigs.filter(
              (c) => c.settings.vodDownload === true && (c.twitch?.enabled ?? c.kick?.enabled) === true
            ).length *
              2 *
              vodLiveHeadroom,
            vodMinConcurrency
          )
        : concurrencyMap[name];

    const config = { ...def, connection };
    if (concurrency !== undefined) {
      config.concurrency = concurrency;
    }
    createWorker<AllJobData>(config);
  }
}
