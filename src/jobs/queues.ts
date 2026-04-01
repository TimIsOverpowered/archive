import { Queue, QueueOptions } from 'bullmq';
import Redis from 'ioredis';

export type VodJobType = 'STANDARD_VOD_DOWNLOAD' | 'LIVE_HLS_DOWNLOAD';

export interface VODDownloadJob {
  streamerId: string;
  vodId: string;
  platform: 'twitch' | 'kick';
  externalVodId?: string;
}

export interface LiveHlsDownloadJob {
  vodId: string;
  platform: 'twitch' | 'kick';
  streamerId: string;
  startedAt?: string; // ISO timestamp when live stream was detected
  sourceUrl?: string; // Kick HLS URL (passed from monitor)
  isFallback?: boolean; // Flag for Twitch fallback mode (no VOD object found)
}

export interface ChatDownloadJob {
  streamerId: string;
  vodId: string;
  platform: 'twitch' | 'kick';
  duration: number;
  vodStartDate?: string;
  startOffset?: number; // Resume from this offset (in seconds) when regenerating chat
}

export interface YoutubeUploadJob {
  streamerId: string;
  vodId: string;
  filePath: string;
  title: string;
  description: string;
  type: 'vod' | 'game';
  platform?: 'twitch' | 'kick';
  part?: number;
  chapter?: {
    name: string;
    start: number;
    end: number;
    gameId?: string;
  };
  dmcaProcessed?: boolean;
}

export interface DmcaProcessingJob {
  streamerId: string;
  vodId: string;
  receivedClaims: Array<{
    type: 'CLAIM_TYPE_AUDIO' | 'CLAIM_TYPE_VISUAL' | 'CLAIM_TYPE_AUDIOVISUAL';
    claimPolicy: { primaryPolicy: { policyType: string } };
    matchDetails: { longestMatchStartTimeSeconds: number; longestMatchDurationSeconds: string };
  }>;
  type: 'vod' | 'live';
  platform: 'twitch' | 'kick';
  part?: number;
}

export const QUEUE_NAMES = {
  VOD_DOWNLOAD: 'vod_download',
  CHAT_DOWNLOAD: 'chat_download',
  YOUTUBE_UPLOAD: 'youtube_upload',
  DMCA_PROCESSING: 'dmca_processing',
} as const;

export const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
};

export const youtubeJobOptions = {
  ...defaultJobOptions,
  attempts: 5,
};

const redisConnection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null, // Required by BullMQ workers
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const queueCache = new Map<string, Queue<any, any, string>>();

export function getQueue<TData = unknown, TFinishedData = unknown>(name: string, jobOptions?: QueueOptions['defaultJobOptions']): Queue<TData, TFinishedData, string> {
  const cacheKey = `${name}:${JSON.stringify(jobOptions)}`;

  if (queueCache.has(cacheKey)) {
    return queueCache.get(cacheKey)! as Queue<TData, TFinishedData, string>;
  }

  const queue = new Queue<TData, TFinishedData, string>(name, {
    connection: redisConnection,
    defaultJobOptions: jobOptions || defaultJobOptions,
  });

  queueCache.set(cacheKey, queue);
  return queue;
}

export function getVODDownloadQueue(): Queue<VODDownloadJob, VODDownloadJob, string> {
  return getQueue(QUEUE_NAMES.VOD_DOWNLOAD);
}

export function getLiveHlsDownloadQueue(): Queue<LiveHlsDownloadJob, LiveHlsDownloadJob, string> {
  return getQueue(QUEUE_NAMES.VOD_DOWNLOAD) as unknown as Queue<LiveHlsDownloadJob, LiveHlsDownloadJob, string>;
}

export function getChatDownloadQueue(): Queue<ChatDownloadJob, ChatDownloadJob, string> {
  return getQueue(QUEUE_NAMES.CHAT_DOWNLOAD);
}

export function getYoutubeUploadQueue(): Queue<YoutubeUploadJob, YoutubeUploadJob, string> {
  return getQueue(QUEUE_NAMES.YOUTUBE_UPLOAD, youtubeJobOptions);
}

export function getDmcaProcessingQueue(): Queue<DmcaProcessingJob, DmcaProcessingJob, string> {
  return getQueue(QUEUE_NAMES.DMCA_PROCESSING);
}

export async function closeQueues(): Promise<void> {
  for (const queue of queueCache.values()) {
    await queue.close();
  }
  queueCache.clear();
  await redisConnection.quit();
}
