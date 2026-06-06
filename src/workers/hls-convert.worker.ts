import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { Job } from 'bullmq';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { initRichAlert, isAlertsEnabled } from '../utils/discord-alerts.js';
import type { AppLogger } from '../utils/logger.js';
import type { HlsConvertJob, HlsConvertResult } from './jobs/types.js';
import { createHlsConvertWorkerAlerts, safeUpdateAlert } from './utils/alert-factories.js';
import { wrapWorkerProcessor } from './utils/worker-wrapper.js';
import { convertHlsSegmentsToMp4 } from './utils/ffmpeg.js';

interface HlsConvertProcessorContext {
  job: Job<HlsConvertJob>;
  log: AppLogger;
  tenantId: string;
  dbId: number;
  vodId: string;
  hlsDirPath: string;
  outputMp4Path: string;
}

const buildHlsConvertContext = async (job: Job<HlsConvertJob>): Promise<HlsConvertProcessorContext> => {
  const { tenantId, dbId, vodId, hlsDirPath, outputMp4Path } = job.data;
  return Promise.resolve({
    job,
    log: createAutoLogger(String(tenantId)),
    tenantId,
    dbId,
    vodId,
    hlsDirPath,
    outputMp4Path,
  });
};

const errorMeta = (ctx: HlsConvertProcessorContext, job: Job) => ({
  vodId: ctx.vodId,
  tenantId: ctx.tenantId,
  dbId: ctx.dbId,
  jobId: job.id,
  hlsDirPath: ctx.hlsDirPath,
  outputMp4Path: ctx.outputMp4Path,
});

const hlsConvertProcessor = wrapWorkerProcessor<HlsConvertJob, HlsConvertProcessorContext, HlsConvertResult>(
  buildHlsConvertContext,
  async (ctx) => {
    const { log, vodId, hlsDirPath, outputMp4Path } = ctx;
    const destDir = path.dirname(outputMp4Path);
    await fsPromises.mkdir(destDir, { recursive: true });

    const alerts = createHlsConvertWorkerAlerts();
    let messageId: string | null = null;

    if (isAlertsEnabled()) {
      messageId = await initRichAlert(alerts.init(vodId, hlsDirPath, outputMp4Path));
    }

    const startTime = Date.now();

    await convertHlsSegmentsToMp4(hlsDirPath, outputMp4Path, vodId, log);

    const elapsedSeconds = (Date.now() - startTime) / 1000;

    log.info({ hlsDirPath, outputMp4Path, elapsedSeconds }, 'HLS conversion completed successfully');

    if (messageId != null) {
      safeUpdateAlert(messageId, alerts.complete(vodId, outputMp4Path, elapsedSeconds), log, vodId);
    }

    return { success: true, filePath: outputMp4Path };
  },
  {
    errorMeta,
    errorAlert: (ctx, _job, errorMsg) => {
      const alerts = createHlsConvertWorkerAlerts();
      if (isAlertsEnabled()) {
        void initRichAlert(alerts.error(ctx.vodId, 0, 0, errorMsg)).catch(() => {});
      }
      return Promise.resolve();
    },
  }
);

export default hlsConvertProcessor;
