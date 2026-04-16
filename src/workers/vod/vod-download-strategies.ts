import { getVodTokenSig } from '../../services/twitch/index.js';
import { getVod as getKickVod, getKickParsedM3u8ForFfmpeg } from '../../services/kick.js';
import { convertHlsToMp4, detectFmp4FromPlaylist } from '../utils/ffmpeg.js';
import type { AppLogger } from '../../utils/auto-tenant-logger.js';
import type { TenantConfig } from '../../config/types.js';
import { PLATFORMS, type Platform } from '../../types/platforms.js';
import { request } from '../../utils/http-client.js';
import { sendVodDownloadFailed, sendVodDownloadStarted, sendVodDownloadSuccess } from '../../utils/discord-alerts.js';
import { extractErrorDetails } from '../../utils/error.js';

export interface VodDownloadResult {
  finalPath: string;
}

export async function downloadVodWithFfmpeg(platform: Platform, vodId: string, finalPath: string, config: TenantConfig, log: AppLogger): Promise<VodDownloadResult> {
  log.info({ vodId, platform, method: 'ffmpeg' }, `Starting ffmpeg download for ${vodId}`);

  if (platform === PLATFORMS.KICK) {
    await downloadKickVodWithFfmpeg(vodId, finalPath, config, log);
  } else if (platform === PLATFORMS.TWITCH) {
    await downloadTwitchVodWithFfmpeg(vodId, finalPath, config, log);
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  log.info({ vodId, platform }, `ffmpeg download completed for ${vodId}`);
  return { finalPath };
}

async function downloadKickVodWithFfmpeg(vodId: string, finalPath: string, config: TenantConfig, log: AppLogger): Promise<void> {
  const username = config?.kick?.username;

  if (!username) {
    throw new Error('Kick username not configured for streamer');
  }

  const vodMetadata = await getKickVod(username, vodId);

  if (!vodMetadata?.source) {
    throw new Error('VOD source URL not available');
  }

  const m3u8Url = await getKickParsedM3u8ForFfmpeg(vodMetadata.source);

  if (!m3u8Url) {
    throw new Error('Failed to parse Kick HLS playlist');
  }

  let messageId: string | null = null;

  try {
    const streamerName = config.displayName || config.id;
    messageId = await sendVodDownloadStarted(PLATFORMS.KICK, streamerName, vodId, streamerName);

    // Download directly to MP4 using ffmpeg HLS streaming
    await convertHlsToMp4(m3u8Url, finalPath, { vodId: vodId, isFmp4: false });

    log.info(`Downloaded ${vodId}.mp4`);

    // Success alert
    await sendVodDownloadSuccess(messageId!, PLATFORMS.KICK, vodId, finalPath, streamerName);
  } catch (error) {
    const details = extractErrorDetails(error);
    const errorMsg = details.message.substring(0, 500);

    log.error(`ffmpeg error occurred: ${errorMsg}`);

    // Failure alert
    await sendVodDownloadFailed(messageId!, PLATFORMS.KICK, vodId, errorMsg, config.id);

    throw error;
  }
}

async function downloadTwitchVodWithFfmpeg(vodId: string, finalPath: string, config: TenantConfig, log: AppLogger): Promise<void> {
  const tenantId = config.id;
  if (!config?.settings.vodPath) {
    throw new Error(`No vodPath configured for streamer ${tenantId}`);
  }

  let messageId: string | null = null;

  try {
    const tokenSig = await getVodTokenSig(vodId, tenantId);

    if (!tokenSig) {
      throw new Error(`Failed to get token/sig for ${vodId}`);
    }

    const m3u8Url = `https://usher.ttvnw.net/vod/${vodId}.m3u8?allow_source=true&player=mediaplayer&include_unavailable=true&supported_codecs=av1,h264,hevc&playlist_include_framerate=true&nauthsig=${tokenSig.signature}&nauth=${tokenSig.value}`;

    const streamerName = config.displayName || tenantId;
    messageId = await sendVodDownloadStarted(PLATFORMS.TWITCH, tenantId, vodId, streamerName);

    const m3u8Content = await request(m3u8Url, {
      responseType: 'text',
      timeoutMs: 30000,
    });
    const isFmp4 = detectFmp4FromPlaylist(m3u8Content);

    await convertHlsToMp4(m3u8Url, finalPath, { vodId, isFmp4 });

    log.info(`Downloaded ${vodId}.mp4`);

    await sendVodDownloadSuccess(messageId!, PLATFORMS.TWITCH, vodId, finalPath, streamerName);
  } catch (error) {
    const details = extractErrorDetails(error);
    const errorMsg = details.message.substring(0, 500);

    log.error(`ffmpeg error occurred: ${errorMsg}`);

    if (messageId) {
      await sendVodDownloadFailed(messageId, PLATFORMS.TWITCH, vodId, errorMsg, tenantId);
    }

    throw error;
  }
}
