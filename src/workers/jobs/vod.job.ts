import type { StandardVodJob } from './queues.js';
import { getStandardVodQueue } from './queues.js';

export async function enqueueVodDownload(job: Omit<StandardVodJob, 'id'>, jobId: string): Promise<string | null> {
  const queue = getStandardVodQueue();

  try {
    const addedJob = await queue.add('standard_vod_download', job, {
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
  dbId: number,
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
      dbId,
      vodId,
      platform,
      externalVodId,
    },
    jobId
  );
}
