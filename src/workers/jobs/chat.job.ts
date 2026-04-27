import type { ChatDownloadJob } from './types.js';
import { getChatDownloadQueue } from '../queues/queue.js';
import { childLogger } from '../../utils/logger.js';
import { extractErrorDetails } from '../../utils/error.js';
import { Platform, PLATFORMS } from '../../types/platforms.js';

const log = childLogger({ module: 'chat-job' });

async function enqueue(job: ChatDownloadJob): Promise<string | null> {
  const jobId = `chat_${job.vodId}`;
  try {
    const added = await getChatDownloadQueue().add('chat_download', job, {
      jobId,
      deduplication: { id: jobId },
      removeOnComplete: true,
      removeOnFail: true,
    });
    return added.id ?? null;
  } catch (error) {
    const msg = extractErrorDetails(error).message;
    const isDedup = msg.includes('deduplication');
    if (!isDedup) {
      log.error({ jobId, tenantId: job.tenantId, error: msg }, 'Failed to enqueue chat job');
    }
    return null;
  }
}

export async function triggerChatDownload(
  tenantId: string,
  displayName: string | undefined,
  platformUserId: string,
  dbId: number,
  vodId: string,
  platform: Platform,
  duration: number,
  platformUsername?: string,
  forceRerun?: boolean
): Promise<string | null> {
  if (platform === PLATFORMS.KICK) return null;
  return enqueue({
    tenantId,
    displayName,
    platformUserId,
    platformUsername,
    dbId,
    vodId,
    platform,
    duration,
    forceRerun,
  });
}
