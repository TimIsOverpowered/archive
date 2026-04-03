import type { ChatDownloadJob, VODDownloadJob } from './queues.js';
import { getChatDownloadQueue } from './queues.js';

export async function enqueueChatDownload(job: Omit<ChatDownloadJob, 'id'>, jobId: string): Promise<string | null> {
  const queue = getChatDownloadQueue();

  try {
    const addedJob = await queue.add('chat_download', job, { jobId });
    return addedJob.id ?? null;
  } catch {
    return null;
  }
}

export async function triggerChatDownload(
  tenantId: string,
  platformUserId: string,
  vodId: string,
  platform: 'twitch' | 'kick',
  duration: number,
  vodStartDate?: string,
  platformUsername?: string
): Promise<string | null> {
  const jobId = `chat_${vodId}`;
  return enqueueChatDownload(
    {
      tenantId,
      platformUserId,
      platformUsername,
      vodId,
      platform,
      duration,
      vodStartDate,
    },
    jobId
  );
}

export async function triggerChatAfterVod(vodJob: VODDownloadJob): Promise<string | null> {
  if (vodJob.platform === 'kick') {
    return null;
  }

  const tenantId = vodJob.tenantId || undefined;

  if (!tenantId) {
    return null;
  }

  const jobId = `chat_${vodJob.vodId}`;
  return enqueueChatDownload(
    {
      tenantId: tenantId,
      platformUserId: vodJob.platformUserId,
      platformUsername: vodJob.platformUsername,
      vodId: vodJob.vodId,
      platform: vodJob.platform,
      duration: 0,
    },
    jobId
  );
}
