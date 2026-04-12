import type { ChatDownloadJob, StandardVodJob } from './queues.js';
import { getChatDownloadQueue } from './queues.js';

async function enqueue(job: ChatDownloadJob): Promise<string | null> {
  const jobId = `chat_${job.vodId}`;
  try {
    const added = await getChatDownloadQueue().add('chat_download', job, {
      jobId,
      deduplication: { id: jobId },
    });
    return added.id ?? null;
  } catch {
    return null;
  }
}

export async function triggerChatDownload(
  tenantId: string,
  platformUserId: string,
  dbId: number,
  vodId: string,
  platform: 'twitch' | 'kick',
  duration: number,
  vodStartDate?: string,
  platformUsername?: string
): Promise<string | null> {
  return enqueue({ tenantId, platformUserId, platformUsername, dbId, vodId, platform, duration, vodStartDate });
}

export async function triggerChatAfterVod(vodJob: StandardVodJob): Promise<string | null> {
  if (vodJob.platform === 'kick') return null;

  return enqueue({
    tenantId: vodJob.tenantId,
    dbId: vodJob.dbId,
    vodId: vodJob.vodId,
    platform: vodJob.platform,
    duration: 0,
  });
}
