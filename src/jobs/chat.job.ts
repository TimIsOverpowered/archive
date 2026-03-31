import type { ChatDownloadJob, VODDownloadJob } from './queues.js';
import { getChatDownloadQueue } from './queues.js';

export async function enqueueChatDownload(job: Omit<ChatDownloadJob, 'id'>): Promise<string | null> {
  const queue = getChatDownloadQueue();

  try {
    // Manual type casting due to BullMQ incomplete generic types
    const jobId = await (queue as any).add(job, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      timeout: 600000, // 10 min for chat download
    });

    return jobId;
  } catch {
    return null;
  }
}

export async function triggerChatDownload(streamerId: string, vodId: string, platform: 'twitch' | 'kick', duration: number, vodStartDate?: string): Promise<string | null> {
  const job = enqueueChatDownload({
    streamerId,
    vodId,
    platform,
    duration,
    vodStartDate,
  });

  return job;
}

export async function triggerChatAfterVod(vodJob: VODDownloadJob): Promise<string | null> {
  // Kick chat is deferred for now - no implementation yet
  if (vodJob.platform === 'kick') {
    return null;
  }

  const streamerId = vodJob.streamerId || undefined;

  if (!streamerId) {
    return null;
  }

  const job = enqueueChatDownload({
    streamerId: streamerId as string,
    vodId: vodJob.vodId,
    platform: vodJob.platform,
    duration: 0, // Will be fetched from VOD metadata in worker if needed
  });

  return job;
}
