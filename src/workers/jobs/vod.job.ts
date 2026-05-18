import { Jobs } from '../../constants.js';
import type { Platform, DownloadMethod } from '../../types/platforms.js';
import { extractErrorDetails } from '../../utils/error.js';
import { childLogger } from '../../utils/logger.js';
import { getStandardVodQueue } from '../queues/queue.js';
import { enqueueJobWithLogging } from './enqueue.js';
import type { StandardVodJob } from './types.js';

const log = childLogger({ module: 'vod-job' });

export interface TriggerVodOptions {
  tenantId: string;
  dbId: number;
  vodId: string;
  platform: Platform;
  platformUserId: string;
  platformUsername: string;
  downloadMethod?: DownloadMethod | undefined;
  skipFinalize?: boolean;
}

export async function triggerVodDownload(opts: TriggerVodOptions): Promise<string | null> {
  const { tenantId, dbId, vodId, platform, platformUserId, platformUsername, downloadMethod, skipFinalize } = opts;
  const jobId = `${Jobs.VOD_JOB_PREFIX}${vodId}`;
  const job: StandardVodJob = {
    tenantId,
    dbId,
    vodId,
    platform,
    platformUserId,
    platformUsername,
    downloadMethod,
    ...(skipFinalize !== undefined && { skipFinalize }),
  };

  try {
    const result = await enqueueJobWithLogging({
      queue: getStandardVodQueue(),
      jobName: 'standard_vod_download',
      data: job,
      options: {
        jobId,
        removeOnComplete: true,
        removeOnFail: true,
      },
      logger: { info: log.info.bind(log), debug: log.debug.bind(log) },
      successMessage: 'VOD download job enqueued',
      extraContext: { tenantId, vodId, platform },
    });
    return result.isNew ? result.jobId : null;
  } catch (error) {
    log.error({ jobId, tenantId, error: extractErrorDetails(error).message }, 'Failed to enqueue VOD job');
    return null;
  }
}
