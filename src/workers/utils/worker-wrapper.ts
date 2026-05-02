import type { Job, Processor } from 'bullmq';
import { handleWorkerError } from './error-handler.js';
import type { WorkerErrorContext } from './error-handler.js';
import type { AppLogger } from '../../utils/logger.js';

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
      if (ctx) {
        const errorMsg = handleWorkerError(error, ctx.log, options.errorMeta(ctx, job));
        await options.errorAlert(ctx, job, errorMsg);
      }
      throw error;
    } finally {
      if (ctx) {
        await finallyHook(ctx);
      }
    }
  };
}
