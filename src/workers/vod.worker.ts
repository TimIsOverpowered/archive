import { Processor, Job } from 'bullmq';
import Redis from 'ioredis';

interface LiveHlsDownloadJobData {
  vodId: string;
  platform: 'twitch' | 'kick';
  streamerId: string;
  startedAt?: string;
  sourceUrl?: string;
}

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

async function clearVodDedupKey(vodId: string): Promise<void> {
  try {
    const dedupKey = `vod_download:${vodId}`;
    await redis.del(dedupKey);
  } catch {
    // Silent fail - non-critical cleanup operation
  }
}

const vodProcessor: Processor<any> = async (job: Job<any>) => {
  if (job.name === 'live_hls_download') {
    const liveJob = job as Job<LiveHlsDownloadJobData>;

    try {
      // Import the consolidated HLS downloader dynamically to avoid circular dependencies
      const { downloadLiveHls } = await import('./vod/hls-downloader');

      return await downloadLiveHls({
        vodId: liveJob.data.vodId,
        platform: liveJob.data.platform,
        streamerId: liveJob.data.streamerId,
        startedAt: liveJob.data.startedAt,
        sourceUrl: liveJob.data.sourceUrl,
      });
    } catch (error: any) {
      // Re-throw to trigger BullMQ retry logic
      throw error;
    } finally {
      await clearVodDedupKey(liveJob.data.vodId);
    }
  } else {
    throw new Error(`Unknown job type: ${job.name}. Only 'live_hls_download' is supported.`);
  }
};

export default vodProcessor;
