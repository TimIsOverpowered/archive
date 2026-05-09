import { Processor } from 'bullmq';
import type { Redis } from 'ioredis';
import { getWorkersConfig } from '../config/env.js';
import type { TenantConfig } from '../config/types.js';
import chatProcessor from './chat.worker.js';
import { createWorker } from './create-worker.js';
import dmcaProcessor from './dmca.worker.js';
import type {
  LiveDownloadJob,
  StandardVodJob,
  ChatDownloadJob,
  YoutubeUploadJob,
  DmcaProcessingJob,
  MonitorJob,
  LiveDownloadResult,
  StandardVodResult,
  ChatDownloadResult,
  YoutubeUploadResult,
  DmcaProcessingResult,
  MonitorJobResult,
} from './jobs/types.js';
import liveProcessor from './live.worker.js';
import monitorProcessor from './monitor/processor.js';
import { QUEUE_NAMES, WorkerName } from './queues/queue.js';
import standardVodProcessor from './vod.worker.js';
import youtubeProcessor from './youtube.worker.js';

function calcLiveConcurrency(configs: TenantConfig[], headroom: number, minConcurrency: number): number {
  const active = configs.filter(
    (c) => c.settings.vodDownload === true && (c.twitch?.enabled ?? c.kick?.enabled) === true
  ).length;
  return Math.max(active * 2 * headroom, minConcurrency);
}

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
  } satisfies WorkerDef<LiveDownloadJob, LiveDownloadResult>,

  [QUEUE_NAMES.VOD_STANDARD]: {
    name: QUEUE_NAMES.VOD_STANDARD,
    processor: standardVodProcessor,
  } satisfies WorkerDef<StandardVodJob, StandardVodResult>,

  [QUEUE_NAMES.CHAT_DOWNLOAD]: {
    name: QUEUE_NAMES.CHAT_DOWNLOAD,
    processor: chatProcessor,
  } satisfies WorkerDef<ChatDownloadJob, ChatDownloadResult>,

  [QUEUE_NAMES.YOUTUBE_UPLOAD]: {
    name: QUEUE_NAMES.YOUTUBE_UPLOAD,
    processor: youtubeProcessor,
  } satisfies WorkerDef<YoutubeUploadJob, YoutubeUploadResult>,

  [QUEUE_NAMES.DMCA_PROCESSING]: {
    name: QUEUE_NAMES.DMCA_PROCESSING,
    processor: dmcaProcessor,
  } satisfies WorkerDef<DmcaProcessingJob, DmcaProcessingResult>,

  [QUEUE_NAMES.MONITOR]: {
    name: QUEUE_NAMES.MONITOR,
    processor: monitorProcessor,
  } satisfies WorkerDef<MonitorJob, MonitorJobResult>,
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
        ? calcLiveConcurrency(tenantConfigs, vodLiveHeadroom, vodMinConcurrency)
        : concurrencyMap[name];

    const config = { ...def, connection };
    if (concurrency !== undefined) {
      config.concurrency = concurrency;
    }
    createWorker<AllJobData>(config);
  }
}
