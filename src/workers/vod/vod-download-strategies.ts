import { getVodTokenSig } from '../../services/twitch/index.js';
import { getVod as getKickVod, getKickParsedM3u8ForFfmpeg } from '../../services/kick/index.js';
import { convertHlsToMp4, detectFmp4FromPlaylist } from '../utils/ffmpeg.js';
import { createVodWorkerAlerts } from '../utils/alert-factories.js';
import { initRichAlert, updateAlert } from '../../utils/discord-alerts.js';
import type { AppLogger } from '../../utils/logger.js';
import type { TenantConfig } from '../../config/types.js';
import { getDisplayName } from '../../config/types.js';
import { PLATFORMS, type Platform } from '../../types/platforms.js';
import { request } from '../../utils/http-client.js';
import { extractErrorDetails } from '../../utils/error.js';
import { TWITCH_USHER_BASE_URL } from '../../constants.js';
import { ConfigNotConfiguredError } from '../../utils/domain-errors.js';

export interface VodDownloadResult {
  finalPath: string;
}

async function withVodAlerts<T>(
  vodId: string,
  platform: Platform,
  config: TenantConfig,
  fn: (messageId: string | null, updateProgress: (pct: number) => void) => Promise<T>
): Promise<T> {
  const alerts = createVodWorkerAlerts();
  const displayName = getDisplayName(config);
  const messageId = await initRichAlert(alerts.init(vodId, platform, displayName));
  try {
    const result = await fn(messageId, (pct) => {
      if (messageId !== null) void updateAlert(messageId, alerts.progress(vodId, `Converting ${vodId} (${pct}%)`));
    });
    if (messageId !== null) await updateAlert(messageId, alerts.complete(vodId, platform, ''));
    return result;
  } catch (error) {
    if (messageId !== null) await updateAlert(messageId, alerts.error(vodId, platform, extractErrorDetails(error).message.substring(0, 500)));
    throw error;
  }
}

export async function downloadVodWithFfmpeg(
  platform: Platform,
  vodId: string,
  finalPath: string,
  config: TenantConfig,
  log: AppLogger
): Promise<VodDownloadResult> {
  log.info({ vodId, platform, method: 'ffmpeg' }, `Starting ffmpeg download for ${vodId}`);

  if (platform === PLATFORMS.KICK) {
    await downloadKickVodWithFfmpeg(vodId, finalPath, config, log);
  } else if (platform === PLATFORMS.TWITCH) {
    await downloadTwitchVodWithFfmpeg(vodId, finalPath, config, log);
  } else {
    throw new Error(`Unsupported platform: ${String(platform)}`);
  }

  log.info({ vodId, platform }, `ffmpeg download completed for ${vodId}`);
  return { finalPath };
}

async function downloadKickVodWithFfmpeg(
  vodId: string,
  finalPath: string,
  config: TenantConfig,
  log: AppLogger
): Promise<void> {
  const username = config?.kick?.username;

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

  await withVodAlerts(vodId, PLATFORMS.KICK, config, async (_messageId, updateProgress) => {
    await convertHlsToMp4(m3u8Url, finalPath, {
      vodId: vodId,
      isFmp4: false,
      onProgress: (percent) => {
        updateProgress(percent);
      },
    });

    log.info(`Downloaded ${vodId}.mp4`);
  });
}

async function downloadTwitchVodWithFfmpeg(
  vodId: string,
  finalPath: string,
  config: TenantConfig,
  log: AppLogger
): Promise<void> {
  const tenantId = config.id;

  const tokenSig = await getVodTokenSig(vodId, tenantId);

  if (tokenSig == null) {
    throw new Error(`Failed to get token/sig for ${vodId}`);
  }

  const m3u8Url = `${TWITCH_USHER_BASE_URL}/${vodId}.m3u8?allow_source=true&player=mediaplayer&include_unavailable=true&supported_codecs=av1,h264,hevc&playlist_include_framerate=true&nauthsig=${tokenSig.signature}&nauth=${tokenSig.value}`;

  const m3u8Content = await request(m3u8Url, {
    responseType: 'text',
    timeoutMs: 30000,
  });
  const isFmp4 = detectFmp4FromPlaylist(m3u8Content);

  await withVodAlerts(vodId, PLATFORMS.TWITCH, config, async (_messageId, updateProgress) => {
    await convertHlsToMp4(m3u8Url, finalPath, {
      vodId,
      isFmp4,
      onProgress: (percent) => {
        updateProgress(percent);
      },
    });

    log.info(`Downloaded ${vodId}.mp4`);
  });
}
