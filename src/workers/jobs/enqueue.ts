import { Queue, JobsOptions, type JobState } from 'bullmq';

export interface JobLogger {
  info: (context: Record<string, unknown>, message: string) => void;
  debug: (context: Record<string, unknown>, message: string) => void;
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
    }
  }

  if (await queue.isPaused()) {
    logger.debug({ jobId, ...extraContext }, 'Queue is paused, skipping job enqueue');
    return { jobId, isNew: false };
  }

  const job = await queue.add(jobName, data, options);
  logger.info({ jobId: String(job.id), ...extraContext }, successMessage);
  return { jobId: String(job.id), isNew: true };
}
