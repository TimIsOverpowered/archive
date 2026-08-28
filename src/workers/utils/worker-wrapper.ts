import type { Job, Processor } from 'bullmq';
import { extractErrorDetails } from '../../utils/error.ts';
import type { AppLogger } from '../../utils/logger.ts';
import { getLogger } from '../../utils/logger.ts';
import type { WorkerErrorContext } from './error-handler.ts';
import { handleWorkerError } from './error-handler.ts';

/**
 * Describes how a wrapped processor attempt ended.
 */
export interface WorkerOutcome {
  /** True when the processor threw (the job attempt failed). */
  failed: boolean;
  /** The error that caused the failure. Present only when `failed` is true. */
  error?: unknown;
  /**
   * True when BullMQ will schedule another attempt for this job. Only meaningful
   * when `failed` is true. When false on a failure, the failure is permanent
   * (retries exhausted or the error is unrecoverable).
   */
  willRetry: boolean;
}

export interface WrapWorkerProcessorOptions<TCtx> {
  errorMeta: (ctx: TCtx, job: Job) => WorkerErrorContext;
  errorAlert: (ctx: TCtx, job: Job, errorMsg: string) => Promise<void>;
  finally?: (ctx: TCtx, job: Job, outcome: WorkerOutcome) => Promise<void>;
}

const noopFinally = async <TCtx>(_ctx: TCtx, _job: Job, _outcome: WorkerOutcome): Promise<void> => {};

/**
 * Mirrors BullMQ's `shouldRetryJob` decision so callers can distinguish a
 * permanent failure from one that will be retried. It reads the same job fields
 * BullMQ uses (`attemptsMade`, `opts.attempts`) at the same pre-increment point
 * the processor's `finally` hook runs, so the result is consistent with the
 * real retry behavior.
 */
function willBeRetried(job: Job, error: unknown): boolean {
  const attempts = job.opts?.attempts;
  if (attempts == null || attempts <= 0) return false;
  if (error != null && (error as { name?: string }).name === 'UnrecoverableError') return false;
  return (job.attemptsMade ?? 0) + 1 < attempts;
}

export function wrapWorkerProcessor<TJobData, TCtx extends { log: AppLogger }, TResult>(
  buildCtx: (job: Job<TJobData>) => Promise<TCtx>,
  processor: (ctx: TCtx) => Promise<TResult>,
  options: WrapWorkerProcessorOptions<TCtx>
): Processor<TJobData, TResult> {
  const { finally: finallyHook = noopFinally } = options;

  return async (job: Job<TJobData>): Promise<TResult> => {
    let ctx: TCtx | undefined;
    let outcome: WorkerOutcome = { failed: false, willRetry: false };

    try {
      ctx = await buildCtx(job);
      return await processor(ctx);
    } catch (error) {
      outcome = { failed: true, error, willRetry: willBeRetried(job, error) };
      if (!ctx) {
        getLogger().error({ jobId: job.id, error: extractErrorDetails(error) }, 'Worker context build failed');
      } else {
        const errorMsg = handleWorkerError(error, ctx.log, options.errorMeta(ctx, job));
        await options.errorAlert(ctx, job, errorMsg).catch((alertErr) => {
          getLogger().warn({ alertErr: extractErrorDetails(alertErr) }, 'Error alert failed to send');
        });
      }
      throw error;
    } finally {
      if (ctx) {
        await finallyHook(ctx, job, outcome);
      }
    }
  };
}
