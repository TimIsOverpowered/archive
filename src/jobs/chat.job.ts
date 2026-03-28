import { getChatDownloadQueue } from './queues.js';
import type { ChatDownloadJob, VODDownloadJob } from './queues.js';

export async function enqueueChatDownload(job: Omit<ChatDownloadJob, 'id'>): Promise<string | null> {
  const queue = getChatDownloadQueue();

  try {
    // Manual type casting due to BullMQ incomplete generic types
    const jobId = await (queue as any).add(job, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      timeout: 600000, // 10 min for chat download
    });

    console.log(`[Chat Job] Enqueued ${job.platform} chat download: ${job.vodId}`);
    return jobId;
  } catch (error) {
    console.error('[Chat Job] Failed to enqueue job:', error);
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
    console.log('[Chat Job] Chat download deferred for Kick platform');
    return null;
  }

  const streamerId = vodJob.streamerId || vodJob.userId;

  if (!streamerId) {
    console.warn('[Chat Job] No streamerId or userId available, skipping chat download');
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
