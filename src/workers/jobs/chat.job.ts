import { configService } from '../../config/tenant-config.ts';
import { Jobs } from '../../constants.ts';
import type { Platform } from '../../types/platforms.ts';
import { isKickPlatform, isTwitchPlatform } from '../../types/platforms.ts';
import { extractErrorDetails } from '../../utils/error.ts';
import { childLogger } from '../../utils/logger.ts';
import { getKickChatDownloadQueue, getTwitchChatDownloadQueue } from '../queues/queue.ts';
import { enqueueJobWithLogging } from './enqueue.ts';
import type { ChatDownloadJob } from './types.ts';

const log = childLogger({ module: 'chat-job' });

async function enqueue(job: ChatDownloadJob): Promise<string | null> {
  const jobId = `${Jobs.CHAT_JOB_PREFIX}${job.vodId}`;
  try {
    const queue = isKickPlatform(job.platform)
      ? getKickChatDownloadQueue()
      : isTwitchPlatform(job.platform)
        ? getTwitchChatDownloadQueue()
        : null;

    if (!queue) {
      log.info({ platform: job.platform }, 'Chat download queue not found for platform');
      return null;
    }

    const result = await enqueueJobWithLogging({
      queue,
      jobName: 'chat_download',
      data: job,
      options: {
        jobId,
      },
      logger: { info: log.info.bind(log), debug: log.debug.bind(log) },
      successMessage: 'Chat download job enqueued',
      extraContext: { tenantId: job.tenantId, vodId: job.vodId, platform: job.platform },
    });
    return result.isNew ? result.jobId : null;
  } catch (error) {
    log.error(
      { jobId, tenantId: job.tenantId, error: extractErrorDetails(error).message },
      'Failed to enqueue chat job'
    );
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
  const config = await configService.get(opts.tenantId);
  if (config?.settings?.chatDownload === false) {
    log.info(
      { tenantId: opts.tenantId, vodId: opts.vodId, platform: opts.platform },
      'Chat download disabled by tenant settings — skipping'
    );
    return null;
  }

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
