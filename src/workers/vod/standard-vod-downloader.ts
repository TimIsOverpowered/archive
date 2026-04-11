import fsPromises from 'fs/promises';
import pathMod from 'path';
import HLS from 'hls-parser';
import { getTenantConfig } from '../../config/loader.js';
import { convertHlsToMp4, detectFmp4FromPlaylist } from '../../utils/ffmpeg.js';
import { getKickParsedM3u8ForFfmpeg, getVod } from '../../services/kick.js';
import { getVodTokenSig } from '../../services/twitch.js';
import { createAutoLogger as loggerWithTenant } from '../../utils/auto-tenant-logger.js';
import { sendVodDownloadStarted, sendVodDownloadSuccess, sendVodDownloadFailed } from '../../utils/discord-alerts.js';
import { extractErrorDetails } from '../../utils/error.js';
import { createSession } from '../../utils/cycletls.js';
import { fileExists } from '../../utils/path.js';
import { downloadSegmentsParallel, fetchTwitchPlaylist, fetchKickPlaylist, type DownloadStrategy } from './hls-utils.js';

export interface StandardVodDownloadOptions {
  dbId: number;
  vodId: string;
  platform: 'twitch' | 'kick';
  tenantId: string;
  platformUserId: string;
  uploadMode?: 'vod' | 'all';
  downloadMethod?: 'ffmpeg' | 'hls';
}

export interface StandardVodDownloadResult {
  success: true;
  finalPath: string;
  durationSeconds?: number;
}

export async function downloadStandardVod(options: StandardVodDownloadOptions): Promise<StandardVodDownloadResult> {
  const { dbId, vodId, platform, tenantId, uploadMode, downloadMethod = 'hls' } = options;
  const log = loggerWithTenant(tenantId);

  const config = getTenantConfig(tenantId);

  if (!config?.settings.vodPath) {
    throw new Error(`No vodPath configured for streamer ${tenantId}`);
  }

  const { getVodFilePath } = await import('../../utils/path.js');

  const finalPath = getVodFilePath({ tenantId, vodId });
  const streamerName = config.displayName || tenantId;
  let messageId: string | null = null;

  try {
    messageId = await sendVodDownloadStarted(platform, tenantId, vodId, streamerName);

    if (downloadMethod === 'ffmpeg') {
      await downloadWithFfmpeg(platform, vodId, finalPath, tenantId, dbId, config, log);
    } else {
      await downloadWithHls(platform, vodId, finalPath, tenantId, dbId, config, log);
    }

    log.info({ vodId, platform }, `Downloaded ${vodId}.mp4`);

    await sendVodDownloadSuccess(messageId!, platform, vodId, finalPath, streamerName);

    if (uploadMode) {
      //await queueYoutubeUpload(tenantId, dbId, vodId, finalPath, uploadMode, platform, log);
    }

    return { success: true, finalPath };
  } catch (error) {
    const details = extractErrorDetails(error);
    const errorMsg = details.message.substring(0, 500);

    log.error({ vodId, platform, error: errorMsg }, `Standard VOD download failed`);

    await sendVodDownloadFailed(messageId!, platform, vodId, errorMsg, tenantId);

    throw error;
  }
}

async function downloadWithFfmpeg(
  platform: 'twitch' | 'kick',
  vodId: string,
  finalPath: string,
  tenantId: string,
  dbId: number,
  config: ReturnType<typeof getTenantConfig>,
  log: ReturnType<typeof loggerWithTenant>
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

    const m3u8Content = await response.text();
    const isFmp4 = detectFmp4FromPlaylist(m3u8Content);

    await convertHlsToMp4(m3u8Url, finalPath, { vodId, isFmp4 });
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
  dbId: number,
  config: ReturnType<typeof getTenantConfig>,
  log: ReturnType<typeof loggerWithTenant>
): Promise<void> {
  const { getVodDirPath } = await import('../../utils/path.js');

  const vodDir = getVodDirPath({ tenantId, vodId });
  const m3u8Path = pathMod.join(vodDir, `${vodId}.m3u8`);

  try {
    await fsPromises.mkdir(vodDir, { recursive: true });
    log.debug({ vodId }, `Created download directory: ${vodDir}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new Error(`Failed to create VOD directory ${vodDir}: ${(error as Error).message}`);
    }
  }

  let cycleTLS: Awaited<ReturnType<typeof createSession>> | null = null;
  let baseURL: string = '';
  let m3u8Content: string = '';
  let isFmp4: boolean = false;

  try {
    if (platform === 'twitch') {
      const result = await fetchTwitchPlaylist(vodId, log, 0, 12);

      if (!result) {
        throw new Error('Failed to fetch Twitch HLS playlist');
      }

      m3u8Content = result.variantM3u8String;
      baseURL = result.baseURL;
      isFmp4 = detectFmp4FromPlaylist(m3u8Content);
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

      m3u8Content = result.variantM3u8String;
      baseURL = result.baseURL;
      isFmp4 = false;
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    await fsPromises.writeFile(m3u8Path, m3u8Content);

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

    await convertHlsToMp4(m3u8Path, finalPath, { vodId, isFmp4 });
  } finally {
    if (cycleTLS) {
      await cycleTLS.close();
      log.info({ vodId }, `Closed CycleTLS session`);
    }

    const finalMp4Exists = await fileExists(finalPath);

    if (finalMp4Exists) {
      if (!config?.settings.saveHLS) {
        try {
          await fsPromises.rm(vodDir, { recursive: true });
          log.info({ vodId }, `Cleaned up temporary directory ${vodDir}`);
        } catch (error) {
          log.warn({ error: extractErrorDetails(error).message, vodId }, `Failed to clean up temporary directory`);
        }
      } else {
        log.info({ vodId }, `HLS files preserved in ${vodDir} (saveHLS=true)`);
      }
    } else {
      try {
        await fsPromises.rm(vodDir, { recursive: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn({ error: extractErrorDetails(error).message, vodId }, `Cleanup failed`);
        }
      }
    }
  }
}
