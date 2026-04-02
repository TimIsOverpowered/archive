import { Processor, Job } from 'bullmq';
import fsPromises from 'fs/promises';
import pathMod from 'path'; // Standard import is fine here

export interface LiveHlsDownloadJobData {
  vodId: string;
  platform: 'twitch' | 'kick';
  streamerId: string;
  startedAt?: string;
  sourceUrl?: string;
}

export interface LiveHlsDownloadResult {
  success: true;
  finalPath: string;
  durationSeconds?: number;
}

const vodProcessor: Processor<LiveHlsDownloadJobData, LiveHlsDownloadResult, string> = async (job: Job<LiveHlsDownloadJobData, LiveHlsDownloadResult, string>) => {
  if (job.name !== 'live_hls_download') {
    throw new Error(`Unsupported job type: ${job.name}`);
  }

  const { vodId, platform, streamerId, startedAt, sourceUrl } = job.data;

  // 1. Progress Heartbeat (Type-Safe)
  let tickCount = 0;
  const heartbeatTimer = setInterval(async () => {
    tickCount++;
    // Use job.updateProgress() or job.log() instead of (job as any).progress
    await job.updateProgress(tickCount % 100);
  }, 60_000);

  try {
    // 2. Dynamic Imports for heavy modules
    const { cleanupOrphanedTmpFiles, recoverPartialDownload, downloadLiveHls } = await import('./vod/hls-downloader.js');
    const { loggerWithTenant } = await import('../utils/logger.js');
    const { getStreamerConfig } = await import('../config/loader.js');

    const log = loggerWithTenant(String(streamerId));
    const config = getStreamerConfig(String(streamerId));

    if (!config?.settings.vodPath) {
      throw new Error(`No VOD path configured for streamer ${streamerId}`);
    }

    const vodDirPath = pathMod.join(config.settings.vodPath, String(streamerId), vodId);

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
    return await downloadLiveHls({
      vodId,
      platform,
      streamerId,
      startedAt,
      sourceUrl,
    });
  } catch (error: unknown) {
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
  }
};

export default vodProcessor;
