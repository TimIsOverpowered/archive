import { getVODDownloadQueue } from './queues.js';
import type { VODDownloadJob } from './queues.js';

export async function enqueueVodDownload(job: Omit<VODDownloadJob, 'id'>): Promise<string | null> {
  const queue = getVODDownloadQueue();

  try {
    // Manual type casting due to BullMQ incomplete generic types
    const jobId = await (queue as any).add(job, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      timeout: 600000, // 10 min for VOD download
    });

    return jobId;
  } catch {
    return null;
  }
}

export async function triggerVodDownload(streamerId: string, vodId: string, platform: 'twitch' | 'kick', externalVodId: string): Promise<string | null> {
  const job = enqueueVodDownload({
    streamerId,
    vodId,
    platform,
    externalVodId,
  });

  return job;
}
