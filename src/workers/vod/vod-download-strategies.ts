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

export interface VodDownloadResult {
  finalPath: string;
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
    throw new Error(`Unsupported platform: ${platform}`);
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

  const alerts = createVodWorkerAlerts();
  let messageId: string | null = null;

  try {
    const streamerName = getDisplayName(config);
    messageId = await initRichAlert(alerts.init(vodId, PLATFORMS.KICK, streamerName));

    // Download directly to MP4 using ffmpeg HLS streaming
    await convertHlsToMp4(m3u8Url, finalPath, {
      vodId: vodId,
      isFmp4: false,
      onProgress: (percent) => {
        if (messageId) {
          void updateAlert(messageId, alerts.progress(vodId, `Converting ${vodId} (${percent}%)`));
        }
      },
    });

    log.info(`Downloaded ${vodId}.mp4`);

    // Success alert
    if (messageId) {
      await updateAlert(messageId, alerts.complete(vodId, PLATFORMS.KICK, finalPath));
    }
  } catch (error) {
    const details = extractErrorDetails(error);
    const errorMsg = details.message.substring(0, 500);

    log.error(`ffmpeg error occurred: ${errorMsg}`);

    // Failure alert
    if (messageId) {
      await updateAlert(messageId, alerts.error(vodId, PLATFORMS.KICK, errorMsg));
    }

    throw error;
  }
}

async function downloadTwitchVodWithFfmpeg(
  vodId: string,
  finalPath: string,
  config: TenantConfig,
  log: AppLogger
): Promise<void> {
  const tenantId = config.id;

  const alerts = createVodWorkerAlerts();
  let messageId: string | null = null;

  try {
    const tokenSig = await getVodTokenSig(vodId, tenantId);

    if (!tokenSig) {
      throw new Error(`Failed to get token/sig for ${vodId}`);
    }

    const m3u8Url = `${TWITCH_USHER_BASE_URL}/${vodId}.m3u8?allow_source=true&player=mediaplayer&include_unavailable=true&supported_codecs=av1,h264,hevc&playlist_include_framerate=true&nauthsig=${tokenSig.signature}&nauth=${tokenSig.value}`;

    const streamerName = getDisplayName(config);
    messageId = await initRichAlert(alerts.init(vodId, PLATFORMS.TWITCH, streamerName));

    const m3u8Content = await request(m3u8Url, {
      responseType: 'text',
      timeoutMs: 30000,
    });
    const isFmp4 = detectFmp4FromPlaylist(m3u8Content);

    await convertHlsToMp4(m3u8Url, finalPath, {
      vodId,
      isFmp4,
      onProgress: (percent) => {
        if (messageId) {
          void updateAlert(messageId, alerts.progress(vodId, `Converting ${vodId} (${percent}%)`));
        }
      },
    });

    log.info(`Downloaded ${vodId}.mp4`);

    if (messageId) {
      await updateAlert(messageId, alerts.complete(vodId, PLATFORMS.TWITCH, finalPath));
    }
  } catch (error) {
    const details = extractErrorDetails(error);
    const errorMsg = details.message.substring(0, 500);

    log.error(`ffmpeg error occurred: ${errorMsg}`);

    if (messageId) {
      await updateAlert(messageId, alerts.error(vodId, PLATFORMS.TWITCH, errorMsg));
    }

    throw error;
  }
}
