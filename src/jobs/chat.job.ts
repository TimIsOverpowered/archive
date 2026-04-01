import type { ChatDownloadJob, VODDownloadJob } from './queues.js';
import { getChatDownloadQueue } from './queues.js';

export async function enqueueChatDownload(job: Omit<ChatDownloadJob, 'id'>): Promise<string | null> {
  const queue = getChatDownloadQueue();

  try {
    const addedJob = await queue.add('chat_download', job);
    return addedJob.id ?? null;
  } catch {
    return null;
  }
}

export async function triggerChatDownload(streamerId: string, vodId: string, platform: 'twitch' | 'kick', duration: number, vodStartDate?: string): Promise<string | null> {
  return enqueueChatDownload({
    streamerId,
    vodId,
    platform,
    duration,
    vodStartDate,
  });
}

export async function triggerChatAfterVod(vodJob: VODDownloadJob): Promise<string | null> {
  if (vodJob.platform === 'kick') {
    return null;
  }

  const streamerId = vodJob.streamerId || undefined;

  if (!streamerId) {
    return null;
  }

  return enqueueChatDownload({
    streamerId: streamerId as string,
    vodId: vodJob.vodId,
    platform: vodJob.platform,
    duration: 0,
  });
}
