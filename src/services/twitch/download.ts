import { getVodTokenSig } from './vod.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { extractErrorDetails } from '../../utils/error.js';
import { getTenantConfig } from '../../config/loader.js';
import { sendVodDownloadStarted, sendVodDownloadSuccess, sendVodDownloadFailed } from '../../utils/discord-alerts.js';
import { convertHlsToMp4, detectFmp4FromPlaylist } from '../../workers/vod/ffmpeg.js';

const log = createAutoLogger('twitch-download');

export async function downloadVodAsMp4(vodId: string, tenantId: string): Promise<string | null> {
  const config = getTenantConfig(tenantId);

  if (!config?.settings.vodPath) {
    throw new Error(`No vodPath configured for streamer ${tenantId}`);
  }

  let messageId: string | null = null;

  try {
    const tokenSig = await getVodTokenSig(vodId);

    if (!tokenSig) {
      throw new Error(`Failed to get token/sig for ${vodId}`);
    }

    const m3u8Url = `https://usher.ttvnw.net/vod/${vodId}.m3u8?allow_source=true&player=mediaplayer&include_unavailable=true&supported_codecs=av1,h264,hevc&playlist_include_framerate=true&nauthsig=${tokenSig.signature}&nauth=${tokenSig.value}`;

    const { getVodFilePath } = await import('../../utils/path.js');

    const vodPath = getVodFilePath({ tenantId, vodId });

    const streamerName = config.displayName || tenantId;
    messageId = await sendVodDownloadStarted('twitch', tenantId, vodId, streamerName);

    const { request } = await import('../../utils/http-client.js');
    const m3u8Content = await request(m3u8Url, {
      responseType: 'text',
      timeoutMs: 30000,
    });
    const isFmp4 = detectFmp4FromPlaylist(m3u8Content);

    await convertHlsToMp4(m3u8Url, vodPath, { vodId, isFmp4 });

    log.info(`Downloaded ${vodId}.mp4`);

    await sendVodDownloadSuccess(messageId!, 'twitch', vodId, vodPath, streamerName);

    return vodPath;
  } catch (error) {
    const details = extractErrorDetails(error);
    const errorMsg = details.message.substring(0, 500);

    log.error(`ffmpeg error occurred: ${errorMsg}`);

    if (messageId) {
      await sendVodDownloadFailed(messageId, 'twitch', vodId, errorMsg, tenantId);
    }

    throw error;
  }
}
