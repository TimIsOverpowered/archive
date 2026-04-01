import { Processor } from 'bullmq';
import Redis from 'ioredis';

// Define the shape of your job data
export interface LiveHlsDownloadJobData {
  vodId: string;
  platform: 'twitch' | 'kick';
  streamerId: string;
  startedAt?: string;
  sourceUrl?: string;
}

// Define what the job returns when it finishes
export interface LiveHlsDownloadResult {
  success: true;
  finalPath: string;
  durationSeconds?: number;
}

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

async function clearVodDedupKey(vodId: string): Promise<void> {
  try {
    const dedupKey = `vod_download:${vodId}`;
    await redis.del(dedupKey);
  } catch {
    // Silent fail - Redis connection issues shouldn't crash the worker
  }
}

/**
 * BullMQ Processor for VOD tasks with full type safety
 */
const vodProcessor: Processor<LiveHlsDownloadJobData, LiveHlsDownloadResult, string> = async (job) => {
  // Check the job name
  if (job.name !== 'live_hls_download') {
    throw new Error(`Unsupported job type: ${job.name}`);
  }

  const { vodId, platform, streamerId, startedAt, sourceUrl } = job.data;

  try {
    // Dynamic import to keep the worker entrypoint light and avoid circular deps
    const { downloadLiveHls } = await import('./vod/hls-downloader.js');

    // Execute the download
    const result = await downloadLiveHls({
      vodId,
      platform,
      streamerId,
      startedAt,
      sourceUrl,
    });

    return result;
  } catch (error: unknown) {
    // BullMQ automatically handles re-thrown errors by moving the job to 'failed'
    // or retrying based on your Queue configuration.
    throw error;
  } finally {
    // Always clear the deduplication key so a new job can be queued if the stream restarts
    await clearVodDedupKey(vodId);
  }
};

export default vodProcessor;
