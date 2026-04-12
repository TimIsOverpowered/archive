import { getVodTokenSig } from '../../services/twitch.js';
import { getVod, getKickParsedM3u8ForFfmpeg } from '../../services/kick.js';
import { convertHlsToMp4 } from './ffmpeg.js';
import type { AppLogger } from '../../utils/auto-tenant-logger.js';
import type { TenantConfig } from '../../config/types.js';

export interface VodDownloadResult {
  finalPath: string;
}

export async function downloadVodWithFfmpeg(platform: 'twitch' | 'kick', vodId: string, finalPath: string, config: TenantConfig, log: AppLogger): Promise<VodDownloadResult> {
  log.info({ vodId, platform, method: 'ffmpeg' }, `Starting ffmpeg download for ${vodId}`);

  if (platform === 'kick') {
    await downloadKickVodWithFfmpeg(vodId, finalPath, config, log);
  } else if (platform === 'twitch') {
    await downloadTwitchVodWithFfmpeg(vodId, finalPath, log);
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  log.info({ vodId, platform }, `ffmpeg download completed for ${vodId}`);
  return { finalPath };
}

async function downloadKickVodWithFfmpeg(vodId: string, finalPath: string, config: TenantConfig, _log: AppLogger): Promise<void> {
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
}

async function downloadTwitchVodWithFfmpeg(vodId: string, finalPath: string, _log: AppLogger): Promise<void> {
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
}
