import { Jobs } from '../../constants.ts';
import type { Platform } from '../../types/platforms.ts';
import { extractErrorDetails } from '../../utils/error.ts';
import { childLogger } from '../../utils/logger.ts';
import { getBackfillQueue } from '../queues/queue.ts';
import { enqueueJobWithLogging } from './enqueue.ts';

const log = childLogger({ module: 'backfill-job' });

export interface TriggerBackfillOptions {
  tenantId: string;
  platform: Platform;
}

/**
 * Enqueue a VOD backfill for a tenant/platform pair. Idempotent: the job ID is
 * derived from the pair, so re-triggering while a backfill is in flight returns
 * the existing job ID instead of queueing a duplicate.
 *
 * Returns null when the job could not be enqueued.
 */
export async function triggerVodBackfill(
  opts: TriggerBackfillOptions
): Promise<{ jobId: string; isNew: boolean } | null> {
  const { tenantId, platform } = opts;
  const jobId = `${Jobs.BACKFILL_JOB_PREFIX}${tenantId}_${platform}`;

  try {
    const result = await enqueueJobWithLogging({
      queue: getBackfillQueue(),
      jobName: 'vod_backfill',
      data: { tenantId, platform },
      options: { jobId },
      logger: { info: log.info.bind(log), debug: log.debug.bind(log), warn: log.warn.bind(log) },
      successMessage: 'VOD backfill job enqueued',
      extraContext: { tenantId, platform },
    });
    return { jobId: result.jobId, isNew: result.isNew };
  } catch (error) {
    log.error(
      { jobId, tenantId, platform, error: extractErrorDetails(error).message },
      'Failed to enqueue backfill job'
    );
    return null;
  }
}
