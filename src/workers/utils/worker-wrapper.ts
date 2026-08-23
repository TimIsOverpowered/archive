import type { Job, Processor } from 'bullmq';
import { extractErrorDetails } from '../../utils/error.ts';
import type { AppLogger } from '../../utils/logger.ts';
import { getLogger } from '../../utils/logger.ts';
import type { WorkerErrorContext } from './error-handler.ts';
import { handleWorkerError } from './error-handler.ts';

export interface WrapWorkerProcessorOptions<TCtx> {
  errorMeta: (ctx: TCtx, job: Job) => WorkerErrorContext;
  errorAlert: (ctx: TCtx, job: Job, errorMsg: string) => Promise<void>;
  finally?: (ctx: TCtx) => Promise<void>;
}

const noopFinally = async <TCtx>(_ctx: TCtx): Promise<void> => {};

export function wrapWorkerProcessor<TJobData, TCtx extends { log: AppLogger }, TResult>(
  buildCtx: (job: Job<TJobData>) => Promise<TCtx>,
  processor: (ctx: TCtx) => Promise<TResult>,
  options: WrapWorkerProcessorOptions<TCtx>
): Processor<TJobData, TResult> {
  const { finally: finallyHook = noopFinally } = options;

  return async (job: Job<TJobData>): Promise<TResult> => {
    let ctx: TCtx | undefined;

    try {
      ctx = await buildCtx(job);
      return await processor(ctx);
    } catch (error) {
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
        await finallyHook(ctx);
      }
    }
  };
}
