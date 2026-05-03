import type { Platform, SourceType } from '../../types/platforms.js';
import { extractErrorDetails } from '../../utils/error.js';
import { childLogger } from '../../utils/logger.js';
import type { DMCAClaim } from '../dmca/dmca.js';
import { defaultJobOptions, getDmcaProcessingQueue, getFlowProducer, getStandardVodQueue } from '../queues/queue.js';
import { enqueueJobWithLogging } from './enqueue.js';
import type { DmcaProcessingJob } from './types.js';

const log = childLogger({ module: 'dmca-job' });

export interface QueueDmcaProcessingOptions {
  tenantId: string;
  dbId: number;
  vodId: string;
  claims: unknown[];
  type: SourceType;
  platform: Platform;
  part?: number | undefined;
  downloadJobId?: string | undefined;
  filePath?: string | undefined;
  gameId?: number | undefined;
  gameStart?: number | undefined;
  gameEnd?: number | undefined;
}

export async function queueDmcaProcessing(options: QueueDmcaProcessingOptions): Promise<string | null> {
  const { tenantId, dbId, vodId, claims, type, platform, part, downloadJobId, filePath, gameId, gameStart, gameEnd } =
    options;

  const isGameUpload = gameId != null;
  const jobId = isGameUpload ? `dmca_game_${gameId}` : part !== undefined ? `dmca_${vodId}_p${part}` : `dmca_${vodId}`;

  const job: DmcaProcessingJob = {
    tenantId,
    dbId,
    vodId,
    receivedClaims: claims as DMCAClaim[],
    type,
    platform,
    ...(part !== undefined && { part }),
    ...(filePath !== undefined && { filePath }),
    ...(gameId != null && { gameId }),
    ...(gameStart != null && { gameStart }),
    ...(gameEnd != null && { gameEnd }),
  };

  try {
    if (downloadJobId != null) {
      const flow = await getFlowProducer().add({
        name: 'dmca_processing',
        queueName: getDmcaProcessingQueue().name,
        data: job,
        opts: {
          jobId,
          deduplication: { id: jobId },
          ...defaultJobOptions,
        },
        children: [
          {
            name: 'standard_vod_download',
            queueName: getStandardVodQueue().name,
            opts: { jobId: downloadJobId },
          },
        ],
      });

      const resultJobId = flow.job.id ?? null;
      log.info(
        { vodId, jobId: resultJobId, part, gameId, chained: true, claimsCount: claims.length },
        'DMCA processing job queued (chained to download)'
      );
      return resultJobId;
    }

    const result = await enqueueJobWithLogging({
      queue: getDmcaProcessingQueue(),
      jobName: 'dmca_processing',
      data: job,
      options: {
        jobId,
        ...defaultJobOptions,
      },
      logger: { info: log.info.bind(log), debug: log.debug.bind(log) },
      successMessage: 'DMCA processing job queued (file exists)',
      extraContext: { vodId, part, gameId, chained: false, claimsCount: claims.length },
    });
    return result.isNew ? result.jobId : null;
  } catch (error) {
    const msg = extractErrorDetails(error).message;
    if (downloadJobId == null) {
      log.error({ jobId, tenantId, error: msg }, 'Failed to enqueue DMCA processing job');
    } else {
      log.debug({ jobId, tenantId, error: msg }, 'DMCA processing enqueue failed (chained)');
    }
    return null;
  }
}
