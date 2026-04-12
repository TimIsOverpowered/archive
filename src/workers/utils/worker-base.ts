import type { Job } from 'bullmq';
import { handleWorkerError } from './error-handler.js';
import type { AppLogger } from '../../utils/auto-tenant-logger.js';
import { initRichAlert, updateAlert } from '../../utils/discord-alerts.js';
import type { RichEmbedData } from '../../utils/discord-alerts.js';

export interface WorkerBaseOptions<TData> {
  job: Job<TData>;
  tenantId: string;
  vodId: string;
  platform: 'twitch' | 'kick';
}

export interface AlertHandlers {
  init: () => Promise<string | null>;
  progress: (message: string) => Promise<void>;
  complete: () => Promise<void>;
  error: (errorMsg: string) => Promise<void>;
}

export interface WorkerContext {
  log: AppLogger;
  messageId: string | null;
}

export async function createWorkerBase<TData, TResult>(options: WorkerBaseOptions<TData>, alertFactory: () => AlertHandlers, processor: (ctx: WorkerContext) => Promise<TResult>): Promise<TResult> {
  const { job, tenantId, vodId, platform } = options;
  const log = ((msg: string, ctx?: Record<string, unknown>) => {
    console.log(`[${job.id}] ${msg}`, ctx || {});
  }) as unknown as AppLogger;

  const alerts = alertFactory();
  const messageId = await alerts.init();

  try {
    const result = await processor({ log, messageId });

    await alerts.complete();
    return result;
  } catch (error) {
    const errorMsg = handleWorkerError(error, log, { vodId, platform, jobId: job.id, tenantId });
    await alerts.error(errorMsg);
    throw error;
  }
}

export function createSimpleAlertHandler(initEmbed: () => RichEmbedData, completeEmbed: () => RichEmbedData, errorEmbed: (errorMsg: string) => RichEmbedData): AlertHandlers {
  return {
    init: async () => initRichAlert(initEmbed()),
    progress: async () => {},
    complete: async () => {
      const msgId = await initRichAlert(completeEmbed());
      if (msgId) await updateAlert(msgId, completeEmbed());
    },
    error: async (errorMsg) => {
      const msgId = await initRichAlert(errorEmbed(errorMsg));
      if (msgId) await updateAlert(msgId, errorEmbed(errorMsg));
    },
  };
}
