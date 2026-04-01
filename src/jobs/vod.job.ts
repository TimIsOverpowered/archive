import type { VODDownloadJob } from './queues.js';
import { getVODDownloadQueue } from './queues.js';

export async function enqueueVodDownload(job: Omit<VODDownloadJob, 'id'>): Promise<string | null> {
  const queue = getVODDownloadQueue();

  try {
    const addedJob = await queue.add('vod_download', job);
    return addedJob.id ?? null;
  } catch {
    return null;
  }
}

export async function triggerVodDownload(streamerId: string, vodId: string, platform: 'twitch' | 'kick', externalVodId: string): Promise<string | null> {
  return enqueueVodDownload({
    streamerId,
    vodId,
    platform,
    externalVodId,
  });
}
