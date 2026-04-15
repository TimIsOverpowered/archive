import type { ChatDownloadJob, StandardVodJob } from './queues.js';
import { getChatDownloadQueue } from './queues.js';
import { childLogger } from '../../utils/logger.js';
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
    const msg = error instanceof Error ? error.message : String(error);
    const isDedup = msg.includes('deduplication');
    if (!isDedup) {
      log.error({ jobId, tenantId: job.tenantId, error: msg }, 'Failed to enqueue chat job');
    }
    return null;
  }
}

export async function triggerChatDownload(
  tenantId: string,
  platformUserId: string,
  dbId: number,
  vodId: string,
  platform: Platform,
  duration: number,
  platformUsername?: string
): Promise<string | null> {
  return enqueue({ tenantId, platformUserId, platformUsername, dbId, vodId, platform, duration });
}

export async function triggerChatAfterVod(vodJob: StandardVodJob): Promise<string | null> {
  if (vodJob.platform === PLATFORMS.KICK) return null;

  return enqueue({
    tenantId: vodJob.tenantId,
    dbId: vodJob.dbId,
    vodId: vodJob.vodId,
    platform: vodJob.platform,
    duration: 0,
  });
}
