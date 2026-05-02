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

export interface TriggerChatOptions {
  tenantId: string;
  displayName?: string | undefined;
  platformUserId: string;
  dbId: number;
  vodId: string;
  platform: Platform;
  duration: number;
  platformUsername?: string | undefined;
  forceRerun?: boolean | undefined;
}

export async function triggerChatDownload(opts: TriggerChatOptions): Promise<string | null> {
  if (opts.platform === PLATFORMS.KICK) return null;
  return enqueue({
    tenantId: opts.tenantId,
    displayName: opts.displayName,
    platformUserId: opts.platformUserId,
    platformUsername: opts.platformUsername,
    dbId: opts.dbId,
    vodId: opts.vodId,
    platform: opts.platform,
    duration: opts.duration,
    forceRerun: opts.forceRerun,
  });
}
