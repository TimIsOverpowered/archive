import { Processor, Job } from 'bullmq';
import { downloadStandardVod } from './vod/standard-vod-downloader.js';

export interface StandardVodDownloadJobData {
  dbId: number;
  vodId: string;
  platform: 'twitch' | 'kick';
  tenantId: string;
  platformUserId: string;
  uploadMode?: 'vod' | 'all';
  downloadMethod?: 'ffmpeg' | 'hls';
}

const vodProcessor: Processor<StandardVodDownloadJobData, unknown, string> = async (job: Job<StandardVodDownloadJobData, unknown, string>) => {
  const { dbId, vodId, platform, tenantId } = job.data;

  const { createAutoLogger: loggerWithTenant } = await import('../utils/auto-tenant-logger.js');

  const log = loggerWithTenant(tenantId);
  log.info({ jobId: job.id, dbId, vodId, platform, tenantId }, '[Standard VOD Processor] Starting job processing');

  const result = await downloadStandardVod({
    dbId,
    vodId,
    platform,
    tenantId,
    platformUserId: job.data.platformUserId,
    uploadMode: job.data.uploadMode,
    downloadMethod: job.data.downloadMethod,
  });

  log.info({ jobId: job.id, dbId, vodId, platform, tenantId }, '[Standard VOD Processor] Job completed successfully');

  return result;
};

export default vodProcessor;
