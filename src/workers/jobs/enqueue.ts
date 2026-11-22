import type { JobState, JobsOptions, Queue } from 'bullmq';
import { getLogger } from '../../utils/logger.ts';

export interface JobLogger {
  info: (context: Record<string, unknown>, message: string) => void;
  debug: (context: Record<string, unknown>, message: string) => void;
  warn: (context: Record<string, unknown>, message: string) => void;
}

export interface JobEnqueueResult {
  jobId: string;
  isNew: boolean;
}

export interface EnqueueJobWithLoggingOpts {
  queue: Queue<unknown, unknown, string>;
  jobName: string;
  data: unknown;
  options: JobsOptions;
  logger: JobLogger;
  successMessage: string;
  extraContext?: Record<string, unknown>;
}

export async function enqueueJobWithLogging(opts: EnqueueJobWithLoggingOpts): Promise<JobEnqueueResult> {
  const { queue, jobName, data, options, logger, successMessage, extraContext } = opts;
  const jobId = options.jobId;

  if (jobId == null) {
    getLogger().warn({ queue: queue.name, jobName }, 'enqueueJobWithLogging called without jobId — skipping');
    return { jobId: '', isNew: false };
  }

  if (jobId !== '') {
    const existing = await queue.getJob(jobId);
    if (existing != null) {
      const state = await existing.getState();
      const SKIPPABLE_STATES: JobState[] = ['active', 'waiting', 'delayed'];
      if (typeof state === 'string' && SKIPPABLE_STATES.includes(state as JobState)) {
        logger.debug({ jobId, state, ...extraContext }, `Job already exists in state ${state}, skipping`);
        return { jobId, isNew: false };
      }
      // Queues that retain finished jobs (see standardVodJobOptions) keep completed/failed
      // jobs in Redis. Re-adding the same jobId would only re-link the old job and never
      // schedule new work, so remove the finished job to let a fresh run be scheduled.
      if (state === 'completed' || state === 'failed') {
        await existing.remove();
        logger.debug({ jobId, state, ...extraContext }, `Removed existing ${state} job before re-enqueue`);
      }
    }
  }

  if (await queue.isPaused()) {
    logger.warn(
      { jobId, ...extraContext },
      'Queue is paused, skipping job enqueue — job will NOT be scheduled until the queue is resumed'
    );
    return { jobId, isNew: false };
  }

  const job = await queue.add(jobName, data, options);
  logger.info({ jobId: String(job.id), ...extraContext }, successMessage);
  return { jobId: String(job.id), isNew: true };
}
