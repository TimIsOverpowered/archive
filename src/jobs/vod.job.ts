import type { VODDownloadJob } from './queues.js';
import { getVODDownloadQueue } from './queues.js';

export async function enqueueVodDownload(job: Omit<VODDownloadJob, 'id'>, jobId: string): Promise<string | null> {
  const queue = getVODDownloadQueue();

  try {
    const addedJob = await queue.add('vod_download', job, {
      jobId,
      deduplication: { id: jobId },
    });
    return addedJob.id ?? null;
  } catch {
    return null;
  }
}

export async function triggerVodDownload(
  tenantId: string,
  platformUserId: string,
  vodId: string,
  platform: 'twitch' | 'kick',
  externalVodId: string,
  platformUsername?: string
): Promise<string | null> {
  const jobId = `vod_${vodId}`;
  return enqueueVodDownload(
    {
      tenantId,
      platformUserId,
      platformUsername,
      vodId,
      platform,
      externalVodId,
    },
    jobId
  );
}
