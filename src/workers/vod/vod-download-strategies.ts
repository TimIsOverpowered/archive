import type { TenantConfig } from '../../config/types.js';
import { Twitch } from '../../constants.js';
import { getVod as getKickVod, getKickParsedM3u8ForFfmpeg } from '../../services/kick/index.js';
import { getVodTokenSig } from '../../services/twitch/index.js';
import { PLATFORMS, type Platform } from '../../types/platforms.js';
import { ConfigNotConfiguredError } from '../../utils/domain-errors.js';
import { request } from '../../utils/http-client.js';
import type { AppLogger } from '../../utils/logger.js';
import { convertHlsToMp4, detectFmp4FromPlaylist } from '../utils/ffmpeg.js';

export interface VodDownloadResult {
  finalPath: string;
}

export async function downloadVodWithFfmpeg(
  platform: Platform,
  vodId: string,
  finalPath: string,
  config: TenantConfig,
  log: AppLogger,
  opts: { messageId: string | null; updateProgress: (pct: number, ffmpegCmd?: string) => void }
): Promise<VodDownloadResult> {
  log.info({ vodId, platform, method: 'ffmpeg' }, 'Starting ffmpeg download');

  if (platform === PLATFORMS.KICK) {
    await downloadKickVodWithFfmpeg(vodId, finalPath, config, log, opts);
  } else if (platform === PLATFORMS.TWITCH) {
    await downloadTwitchVodWithFfmpeg(vodId, finalPath, config, log, opts);
  } else {
    throw new Error(`Unsupported platform: ${String(platform)}`);
  }

  log.info({ vodId, platform }, 'ffmpeg download completed');
  return { finalPath };
}

async function downloadKickVodWithFfmpeg(
  vodId: string,
  finalPath: string,
  config: TenantConfig,
  log: AppLogger,
  opts: { messageId: string | null; updateProgress: (pct: number, ffmpegCmd?: string) => void }
): Promise<void> {
  const username = config.kick?.username;

  if (username == null || username === '') {
    throw new ConfigNotConfiguredError(`Kick username for ${config.id}`);
  }

  const vodMetadata = await getKickVod(username, vodId);

  if (vodMetadata?.source == null || vodMetadata?.source === '') {
    throw new Error('VOD source URL not available');
  }

  const m3u8Url = await getKickParsedM3u8ForFfmpeg(vodMetadata.source);

  if (m3u8Url == null || m3u8Url === '') {
    throw new Error('Failed to parse Kick HLS playlist');
  }

  let kickFfmpegCmd: string | undefined;
  await convertHlsToMp4(m3u8Url, finalPath, {
    vodId: vodId,
    isFmp4: false,
    onProgress: (percent) => {
      const cmd = kickFfmpegCmd;
      opts.updateProgress(percent, cmd);
    },
    onStart: (cmd) => {
      kickFfmpegCmd = cmd;
    },
  });

  log.info({ vodId }, 'Downloaded VOD');
}

async function downloadTwitchVodWithFfmpeg(
  vodId: string,
  finalPath: string,
  config: TenantConfig,
  log: AppLogger,
  opts: { messageId: string | null; updateProgress: (pct: number, ffmpegCmd?: string) => void }
): Promise<void> {
  const tenantId = config.id;

  const tokenSig = await getVodTokenSig(vodId, tenantId);

  if (tokenSig == null) {
    throw new Error(`Failed to get token/sig for ${vodId}`);
  }

  const m3u8Url = `${Twitch.USHER_BASE_URL}/${vodId}.m3u8?allow_source=true&player=mediaplayer&include_unavailable=true&supported_codecs=av1,h264,hevc&playlist_include_framerate=true&nauthsig=${tokenSig.signature}&nauth=${tokenSig.value}`;

  const m3u8Content = await request(m3u8Url, {
    responseType: 'text',
    timeoutMs: 30000,
  });
  const isFmp4 = detectFmp4FromPlaylist(m3u8Content);

  let twitchFfmpegCmd: string | undefined;
  await convertHlsToMp4(m3u8Url, finalPath, {
    vodId,
    isFmp4,
    onProgress: (percent) => {
      const cmd = twitchFfmpegCmd;
      opts.updateProgress(percent, cmd);
    },
    onStart: (cmd) => {
      twitchFfmpegCmd = cmd;
    },
  });

  log.info({ vodId }, 'Downloaded VOD');
}
