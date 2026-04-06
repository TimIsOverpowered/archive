import { Processor, Job } from 'bullmq';
import pathMod from 'path';
import { fileExists } from '../utils/path.js';

export interface LiveHlsDownloadJobData {
  dbId: number;
  vodId: string;
  platform: 'twitch' | 'kick';
  tenantId: string;
  platformUserId: string;
  platformUsername?: string;
  startedAt?: string;
  sourceUrl?: string;
  uploadAfterDownload?: boolean;
  uploadMode?: 'vod' | 'all';
}

export interface StandardVodDownloadJobData {
  dbId: number;
  vodId: string;
  platform: 'twitch' | 'kick';
  tenantId: string;
  platformUserId: string;
  uploadMode?: 'vod' | 'all';
}

export type VODDownloadResult =
  | {
      success: true;
      finalPath: string;
      durationSeconds?: number;
    }
  | {
      success: true;
      finalPath: string;
      durationSeconds?: number;
    };

const vodProcessor: Processor<LiveHlsDownloadJobData | StandardVodDownloadJobData, VODDownloadResult, string> = async (
  job: Job<LiveHlsDownloadJobData | StandardVodDownloadJobData, VODDownloadResult, string>,
  token
) => {
  const signal = (token as { abortSignal?: AbortSignal })?.abortSignal;

  const { dbId, vodId, platform, tenantId } = job.data;

  const { createAutoLogger: loggerWithTenant } = await import('../utils/auto-tenant-logger.js');

  const log = loggerWithTenant(tenantId);
  log.info({ jobId: job.id, dbId, vodId, platform, tenantId }, '[VOD Processor] Starting job processing');

  if (job.name === 'live_hls_download') {
    const { cleanupOrphanedTmpFiles, downloadLiveHls } = await import('./vod/hls-downloader.js');
    const { getTenantConfig } = await import('../config/loader.js');

    const config = getTenantConfig(tenantId);

    if (!config?.settings.vodPath) {
      throw new Error(`VOD path not configured for streamer ${tenantId}`);
    }

    const vodDirPath = pathMod.join(config.settings.livePath || config.settings.vodPath, tenantId, vodId);

    const exists = await fileExists(vodDirPath);

    if (exists) {
      log.debug({ vodId, platform }, `[Recovery] Directory found - cleaning orphaned temp files`);
      await cleanupOrphanedTmpFiles(vodDirPath, log);
    } else {
      log.debug({ vodId, platform }, `[Recovery] Fresh start - directory will be created`);
    }

    const liveData = job.data as LiveHlsDownloadJobData;
    const result = await downloadLiveHls(
      {
        dbId,
        vodId,
        platform,
        tenantId,
        platformUserId: liveData.platformUserId,
        platformUsername: liveData.platformUsername,
        startedAt: liveData.startedAt,
        sourceUrl: liveData.sourceUrl,
        uploadAfterDownload: liveData.uploadAfterDownload,
        uploadMode: liveData.uploadMode,
      },
      signal
    );

    return result!;
  } else if (job.name === 'standard_vod_download') {
    const { downloadStandardVod } = await import('./vod/standard-vod-downloader.js');

    const standardData = job.data as StandardVodDownloadJobData;
    const result = await downloadStandardVod({
      dbId,
      vodId,
      platform,
      tenantId,
      platformUserId: standardData.platformUserId,
      uploadMode: standardData.uploadMode,
    });

    return result;
  } else {
    throw new Error(`Unsupported job type: ${job.name}`);
  }
};

export default vodProcessor;
