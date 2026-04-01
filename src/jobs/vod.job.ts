import type { VODDownloadJob } from './queues.js';
import { getVODDownloadQueue } from './queues.js';

export async function enqueueVodDownload(job: Omit<VODDownloadJob, 'id'>): Promise<string | null> {
  const queue = getVODDownloadQueue();

  try {
    // @ts-expect-error - M5/H5 issue: BullMQ Queue<T> generics don't properly infer job data types, requires cast annotation for add() method calls
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
