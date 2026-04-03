import { Processor, Job } from 'bullmq';
import fsPromises from 'fs/promises';
import pathMod from 'path'; // Standard import is fine here

export interface LiveHlsDownloadJobData {
  vodId: string;
  platform: 'twitch' | 'kick';
  tenantId: string;
  platformUserId: string;
  platformUsername?: string;
  startedAt?: string;
  sourceUrl?: string;
}

export interface LiveHlsDownloadResult {
  success: true;
  finalPath: string;
  durationSeconds?: number;
}

const vodProcessor: Processor<LiveHlsDownloadJobData, LiveHlsDownloadResult, string> = async (job: Job<LiveHlsDownloadJobData, LiveHlsDownloadResult, string>) => {
  const { vodId, platform, tenantId } = job.data;

  if (job.name !== 'live_hls_download') {
    throw new Error(`Unsupported job type: ${job.name}`);
  }

  const { platformUserId, platformUsername, startedAt, sourceUrl } = job.data;

  let result: LiveHlsDownloadResult | undefined;

  // 2. Dynamic Imports for heavy modules
  const { cleanupOrphanedTmpFiles, recoverPartialDownload, downloadLiveHls } = await import('./vod/hls-downloader.js');
  const { createAutoLogger: loggerWithTenant } = await import('../utils/auto-tenant-logger.js');
  const { getStreamerConfig } = await import('../config/loader.js');

  const log = loggerWithTenant(tenantId);
  log.info({ jobId: job.id, vodId, platform, tenantId }, '[VOD Processor] Starting job processing');

  const config = getStreamerConfig(tenantId);

  if (!config?.settings.vodPath) {
    throw new Error(`VOD path not configured for streamer ${tenantId}`);
  }

  const vodDirPath = pathMod.join(config.settings.vodPath, tenantId, vodId);

  // 3. Crash Recovery Logic
  try {
    await fsPromises.access(vodDirPath);
    log.info({ vodId, platform }, `[Recovery] Directory found - attempting resume`);

    await cleanupOrphanedTmpFiles(vodDirPath, log);
    const recoveryInfo = await recoverPartialDownload(vodDirPath, log);

    if (recoveryInfo.totalSegments > 0) {
      log.info({ vodId, platform, count: recoveryInfo.totalSegments }, `[Recovery] Resuming from segment ${recoveryInfo.totalSegments}`);
    }
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      log.debug({ vodId, platform }, `[Recovery] Fresh start - creating directory`);
    } else {
      throw error;
    }
  }

  // 4. Execution
  result = await downloadLiveHls({
    vodId,
    platform,
    tenantId,
    platformUserId,
    platformUsername,
    startedAt,
    sourceUrl,
  });

  return result!;
};

export default vodProcessor;
