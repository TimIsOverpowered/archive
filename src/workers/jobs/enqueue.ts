import { Queue, JobsOptions } from 'bullmq';

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

  if (jobId != null && jobId !== '') {
    const existing = await queue.getJob(String(jobId));
    if (existing != null) {
      const state = await existing.getState();
      if (state === 'active' || state === 'waiting' || state === 'delayed') {
        logger.debug({ jobId, state, ...extraContext }, `Job already exists in state ${state}, skipping`);
        return { jobId: String(jobId), isNew: false };
      }
    }
  }

  const job = await queue.add(jobName, data, options);
  logger.info({ jobId: String(job.id), ...extraContext }, successMessage);
  return { jobId: String(job.id), isNew: true };
}
