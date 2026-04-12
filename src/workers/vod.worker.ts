// vod.worker.ts
import { Processor, Job } from 'bullmq';
import { convertHlsToMp4, detectFmp4FromPlaylist } from '../utils/ffmpeg.js';
import { fileExists, getVodDirPath, getVodFilePath } from '../utils/path.js';
import { initRichAlert, updateAlert } from '../utils/discord-alerts.js';
import { extractErrorDetails } from '../utils/error.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { createSession } from '../utils/cycletls.js';
import { downloadSegmentsParallel, fetchTwitchPlaylist, fetchKickPlaylist, type DownloadStrategy } from './vod/hls-utils.js';
import { getKickParsedM3u8ForFfmpeg, getVod } from '../services/kick.js';
import { getVodTokenSig } from '../services/twitch.js';
import { getJobContext } from './job-context.js';
import { queueYoutubeUploads } from './jobs/youtube.job.js';
import { cleanupHlsFiles } from './vod/hls-cleanup.js';
import fs from 'fs/promises';
import HLS from 'hls-parser';
import type { StandardVodJob } from './jobs/queues.js';

const vodProcessor: Processor<StandardVodJob, unknown, string> = async (job: Job<StandardVodJob, unknown, string>) => {
  const { dbId, vodId, platform, tenantId, uploadMode, downloadMethod = 'hls' } = job.data;
  const log = createAutoLogger(tenantId);

  log.info({ jobId: job.id, dbId, vodId, platform, tenantId }, '[Standard VOD Worker] Starting job');

  const { config } = await getJobContext(tenantId);
  if (!config?.settings.vodPath) throw new Error(`VOD path not configured for ${tenantId}`);

  const finalPath = getVodFilePath({ tenantId, vodId });
  const streamerName = config.displayName || tenantId;

  const messageId = await initRichAlert({
    title: `[VOD] ${vodId} Started`,
    description: `${platform.toUpperCase()} VOD download started`,
    status: 'warning',
    fields: [
      { name: 'Platform', value: platform, inline: true },
      { name: 'Streamer', value: streamerName, inline: true },
    ],
    timestamp: new Date().toISOString(),
  });

  try {
    if (downloadMethod === 'ffmpeg') {
      await downloadWithFfmpeg(platform, vodId, finalPath, config, log);
    } else {
      await downloadWithHls(platform, vodId, finalPath, tenantId, config, log);
    }

    log.info({ vodId, platform }, `Downloaded ${vodId}.mp4`);

    await updateAlert(messageId, {
      title: `[VOD] ${vodId} Complete`,
      description: 'Successfully downloaded',
      status: 'success',
      fields: [
        { name: 'Platform', value: platform, inline: true },
        { name: 'Path', value: finalPath, inline: false },
      ],
      timestamp: new Date().toISOString(),
    });

    if (uploadMode) {
      await queueYoutubeUploads({ tenantId, dbId, vodId, filePath: finalPath, uploadMode, platform, config, log });
    }

    log.info({ jobId: job.id, dbId, vodId, platform, tenantId }, '[Standard VOD Worker] Job completed successfully');
    return { success: true, finalPath };
  } catch (error) {
    const details = extractErrorDetails(error);
    const errorMsg = details.message.substring(0, 500);

    log.error({ vodId, platform, error: errorMsg }, 'Standard VOD download failed');

    await updateAlert(messageId, {
      title: `[VOD] ${vodId} FAILED`,
      description: errorMsg,
      status: 'error',
      fields: [],
      timestamp: new Date().toISOString(),
    });

    throw error;
  }
};

async function downloadWithFfmpeg(
  platform: 'twitch' | 'kick',
  vodId: string,
  finalPath: string,
  config: NonNullable<Awaited<ReturnType<typeof getJobContext>>['config']>,
  log: ReturnType<typeof createAutoLogger>
): Promise<void> {
  log.info({ vodId, platform, method: 'ffmpeg' }, `Starting ffmpeg download for ${vodId}`);

  if (platform === 'kick') {
    const username = config?.kick?.username;

    if (!username) {
      throw new Error('Kick username not configured for streamer');
    }

    const vodMetadata = await getVod(username, vodId);

    if (!vodMetadata?.source) {
      throw new Error('VOD source URL not available');
    }

    const m3u8Url = await getKickParsedM3u8ForFfmpeg(vodMetadata.source);

    if (!m3u8Url) {
      throw new Error('Failed to parse Kick HLS playlist');
    }

    await convertHlsToMp4(m3u8Url, finalPath, { vodId, isFmp4: false });
  } else if (platform === 'twitch') {
    const tokenSig = await getVodTokenSig(vodId);

    if (!tokenSig) {
      throw new Error(`Failed to get token/sig for ${vodId}`);
    }

    const m3u8Url = `https://usher.ttvnw.net/vod/${vodId}.m3u8?allow_source=true&player=mediaplayer&include_unavailable=true&supported_codecs=av1,h264,hevc&playlist_include_framerate=true&nauthsig=${tokenSig.signature}&nauth=${tokenSig.value}`;

    const response = await fetch(m3u8Url);

    if (!response.ok) {
      throw new Error(`Twitch HLS playlist request failed: ${response.status}`);
    }

    await convertHlsToMp4(m3u8Url, finalPath, { vodId, isFmp4: false });
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  log.info({ vodId, platform }, `ffmpeg download completed for ${vodId}`);
}

async function downloadWithHls(
  platform: 'twitch' | 'kick',
  vodId: string,
  finalPath: string,
  tenantId: string,
  config: NonNullable<Awaited<ReturnType<typeof getJobContext>>['config']>,
  log: ReturnType<typeof createAutoLogger>
): Promise<void> {
  const vodDir = getVodDirPath({ tenantId, vodId });
  const m3u8Path = `${vodDir}/${vodId}.m3u8`;

  try {
    await fs.mkdir(vodDir, { recursive: true });
    log.debug({ vodId }, `Created download directory: ${vodDir}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new Error(`Failed to create VOD directory ${vodDir}: ${(error as Error).message}`);
    }
  }

  let cycleTLS: Awaited<ReturnType<typeof createSession>> | null = null;
  let baseURL: string = '';

  try {
    if (platform === 'twitch') {
      const result = await fetchTwitchPlaylist(vodId, log, 0, 12);

      if (!result) {
        throw new Error('Failed to fetch Twitch HLS playlist');
      }

      baseURL = result.baseURL;

      await fs.writeFile(m3u8Path, result.variantM3u8String);
    } else if (platform === 'kick') {
      const username = config?.kick?.username;

      if (!username) {
        throw new Error('Kick username not configured for streamer');
      }

      const vodMetadata = await getVod(username, vodId);

      if (!vodMetadata?.source) {
        throw new Error('VOD source URL not available');
      }

      cycleTLS = createSession();

      const result = await fetchKickPlaylist(vodId, vodMetadata.source, log, 0, 12, cycleTLS);

      if (!result) {
        throw new Error('Failed to fetch Kick HLS playlist');
      }

      baseURL = result.baseURL;

      await fs.writeFile(m3u8Path, result.variantM3u8String);
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    const m3u8Content = await fs.readFile(m3u8Path, 'utf8');
    const parsedM3u8 = HLS.parse(m3u8Content);

    if (!parsedM3u8 || !('segments' in parsedM3u8)) {
      throw new Error('Invalid HLS playlist structure');
    }

    const segments = (parsedM3u8 as HLS.types.MediaPlaylist).segments || [];

    log.debug({ vodId, count: segments.length }, `Found ${segments.length} segments to download`);

    if (segments.length === 0) {
      throw new Error('No segments found in HLS playlist');
    }

    const strategy: DownloadStrategy = platform === 'kick' && cycleTLS ? { type: 'cycletls', session: cycleTLS } : { type: 'fetch' };

    await downloadSegmentsParallel(segments, vodDir, baseURL, strategy, 3, 3, log);

    const isFmp4 = detectFmp4FromPlaylist(m3u8Content);

    await convertHlsToMp4(m3u8Path, finalPath, { vodId, isFmp4 });
  } finally {
    if (cycleTLS) {
      await cycleTLS.close();
      log.info({ vodId }, `Closed CycleTLS session`);
    }

    const finalMp4Exists = await fileExists(finalPath);
    const shouldKeepHls = config?.settings.saveHLS ?? false;

    if (!finalMp4Exists) {
      await cleanupHlsFiles(vodDir, shouldKeepHls, log);
    } else if (!shouldKeepHls) {
      await cleanupHlsFiles(vodDir, shouldKeepHls, log);
    } else {
      log.info({ vodId }, `HLS files preserved in ${vodDir} (saveHLS=true)`);
    }
  }
}

export default vodProcessor;
