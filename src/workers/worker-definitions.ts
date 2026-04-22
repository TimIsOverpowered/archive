import { Processor } from 'bullmq';
import liveProcessor from './live.worker.js';
import standardVodProcessor from './vod.worker.js';
import chatProcessor from './chat.worker.js';
import youtubeProcessor from './youtube.worker.js';
import dmcaProcessor from './dmca.worker.js';
import monitorProcessor from './monitor/processor.js';
import { QUEUE_NAMES, QUEUES_VALUES } from './jobs/queues.js';
import type {
  StandardVodJob,
  ChatDownloadJob,
  YoutubeUploadJob,
  DmcaProcessingJob,
  MonitorJob,
} from './jobs/queues.js';
import type { Redis } from 'ioredis';
import type { TenantConfig } from '../config/types.js';
import { getWorkersConfig, type WorkersConfig } from '../config/env.js';
import { createWorker } from './create-worker.js';

export type WorkerName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
export type AllJobData = StandardVodJob | ChatDownloadJob | YoutubeUploadJob | DmcaProcessingJob | MonitorJob;

export interface WorkerConfig {
  name: WorkerName;
  processor: Processor<Record<string, unknown>, unknown, string>;
  concurrency?: number;
  useWorkerThreads?: boolean;
}

const workerDefs: Record<WorkerName, Omit<WorkerConfig, 'concurrency'>> = {
  vod_live: {
    name: QUEUE_NAMES.VOD_LIVE,
    processor: liveProcessor as unknown as Processor<Record<string, unknown>, unknown, string>,
    useWorkerThreads: true,
  },
  vod_standard: {
    name: QUEUE_NAMES.VOD_STANDARD,
    processor: standardVodProcessor as unknown as Processor<Record<string, unknown>, unknown, string>,
    useWorkerThreads: true,
  },
  chat_download: {
    name: QUEUE_NAMES.CHAT_DOWNLOAD,
    processor: chatProcessor as unknown as Processor<Record<string, unknown>, unknown, string>,
    useWorkerThreads: true,
  },
  youtube_upload: {
    name: QUEUE_NAMES.YOUTUBE_UPLOAD,
    processor: youtubeProcessor as unknown as Processor<Record<string, unknown>, unknown, string>,
    useWorkerThreads: true,
  },
  dmca_processing: {
    name: QUEUE_NAMES.DMCA_PROCESSING,
    processor: dmcaProcessor as unknown as Processor<Record<string, unknown>, unknown, string>,
    useWorkerThreads: true,
  },
  monitor: {
    name: QUEUE_NAMES.MONITOR,
    processor: monitorProcessor as unknown as Processor<Record<string, unknown>, unknown, string>,
    useWorkerThreads: true,
  },
};

const CONCURRENCY_KEYS: Record<WorkerName, keyof WorkersConfig | undefined> = {
  vod_live: undefined,
  vod_standard: 'VOD_STANDARD_CONCURRENCY',
  chat_download: 'CHAT_DOWNLOAD_CONCURRENCY',
  youtube_upload: 'YOUTUBE_UPLOAD_CONCURRENCY',
  dmca_processing: undefined,
  monitor: 'MONITOR_CONCURRENCY',
};

export function registerWorkers(
  connection: Redis,
  tenantConfigs: TenantConfig[],
  vodLiveHeadroom: number,
  vodMinConcurrency: number
): void {
  const workerConfig = getWorkersConfig();

  for (const name of QUEUES_VALUES) {
    const def = workerDefs[name];
    const concurrencyKey = CONCURRENCY_KEYS[name];
    const workerConfigResolved: WorkerConfig & { connection: Redis } = {
      ...def,
      connection,
      ...(concurrencyKey && { concurrency: workerConfig[concurrencyKey] as number }),
    };

    if (name === QUEUE_NAMES.VOD_LIVE) {
      const liveTenants = tenantConfigs.filter((c) => c.settings.vodDownload && (c.twitch?.enabled || c.kick?.enabled));
      workerConfigResolved.concurrency = Math.max(liveTenants.length * 2 * vodLiveHeadroom, vodMinConcurrency);
    }

    createWorker(workerConfigResolved);
  }
}
