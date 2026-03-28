import { Queue, QueueOptions } from 'bullmq';
import Redis from 'ioredis';

export type VodJobType = 'STANDARD_VOD_DOWNLOAD' | 'LIVE_HLS_DOWNLOAD';

export interface VODDownloadJob {
  streamerId?: string; // For backward compatibility with standard downloads
  vodId: string;
  platform: 'twitch' | 'kick';
  externalVodId?: string;
  userId?: string; // Channel/user identifier for multi-tenant tracking (required for Live HLS)
}

export interface LiveHlsDownloadJob {
  vodId: string;
  platform: 'twitch' | 'kick';
  userId: string; // Required - channel ID or username depending on platform
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
}

export const QUEUE_NAMES = {
  VOD_DOWNLOAD: 'vod_download',
  CHAT_DOWNLOAD: 'chat_download',
  YOUTUBE_UPLOAD: 'youtube_upload',
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

const queueCache = new Map<string, Queue>();

export function getQueue(name: string, jobOptions?: QueueOptions['defaultJobOptions']): Queue {
  const cacheKey = `${name}:${JSON.stringify(jobOptions)}`;

  if (queueCache.has(cacheKey)) {
    return queueCache.get(cacheKey)!;
  }

  const queue = new Queue(name as any, {
    connection: redisConnection,
    defaultJobOptions: jobOptions || defaultJobOptions,
  });

  queueCache.set(cacheKey, queue);
  return queue;
}

export function getVODDownloadQueue(): Queue<VODDownloadJob, VODDownloadJob, string> {
  return getQueue(QUEUE_NAMES.VOD_DOWNLOAD) as unknown as Queue<VODDownloadJob, VODDownloadJob, string>;
}

export function getChatDownloadQueue(): Queue<ChatDownloadJob, ChatDownloadJob, string> {
  return getQueue(QUEUE_NAMES.CHAT_DOWNLOAD) as unknown as Queue<ChatDownloadJob, ChatDownloadJob, string>;
}

export function getYoutubeUploadQueue(): Queue<YoutubeUploadJob, YoutubeUploadJob, string> {
  return getQueue(QUEUE_NAMES.YOUTUBE_UPLOAD, youtubeJobOptions) as unknown as Queue<YoutubeUploadJob, YoutubeUploadJob, string>;
}

export async function closeQueues(): Promise<void> {
  for (const queue of queueCache.values()) {
    await queue.close();
  }
  queueCache.clear();
  await redisConnection.quit();
}
