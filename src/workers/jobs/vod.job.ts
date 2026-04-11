import type { StandardVodJob } from './queues.js';
import { getStandardVodQueue } from './queues.js';

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
  const job: StandardVodJob = {
    tenantId,
    platformUserId,
    platformUsername,
    dbId,
    vodId,
    platform,
    externalVodId,
  };

  try {
    const added = await getStandardVodQueue().add('standard_vod_download', job, {
      jobId,
      deduplication: { id: jobId },
    });
    return added.id ?? null;
  } catch {
    return null;
  }
}
