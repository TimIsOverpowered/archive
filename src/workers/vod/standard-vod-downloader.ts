import { getTenantConfig } from '../../config/loader.js';
import { getClient } from '../../db/client.js';
import { convertHlsToMp4, getDuration } from '../../utils/ffmpeg.js';
import { getKickParsedM3u8ForFfmpeg } from '../../services/kick.js';
import { getVodTokenSig, saveVodChapters as saveTwitchVodChapters } from '../../services/twitch.js';
import { finalizeKickChapters } from '../../services/kick.js';
import { queueYoutubeUpload } from '../../utils/upload-queue.js';
import { createAutoLogger as loggerWithTenant } from '../../utils/auto-tenant-logger.js';
import { sendVodDownloadStarted, sendVodDownloadSuccess, sendVodDownloadFailed } from '../../utils/discord-alerts.js';
import { extractErrorDetails } from '../../utils/error.js';

export interface StandardVodDownloadOptions {
  vodId: string;
  platform: 'twitch' | 'kick';
  tenantId: string;
  platformUserId: string;
  uploadMode?: 'vod' | 'all';
}

export interface StandardVodDownloadResult {
  success: true;
  finalPath: string;
  durationSeconds?: number;
}

export async function downloadStandardVod(options: StandardVodDownloadOptions): Promise<StandardVodDownloadResult> {
  const { vodId, platform, tenantId, uploadMode } = options;
  const log = loggerWithTenant(tenantId);

  const config = getTenantConfig(tenantId);

  if (!config?.settings.vodPath) {
    throw new Error(`No vodPath configured for streamer ${tenantId}`);
  }

  const finalPath = `${config.settings.vodPath}/${vodId}.mp4`;
  const streamerName = config.displayName || tenantId;
  let messageId: string | null = null;

  try {
    messageId = await sendVodDownloadStarted(platform, tenantId, vodId, streamerName);

    if (platform === 'kick') {
      const kickModule = await import('../../services/kick.js');
      const username = config?.kick?.username;

      if (!username) {
        throw new Error('Kick username not configured for streamer');
      }

      const vodMetadata = await kickModule.getVod(username, vodId);

      if (!vodMetadata?.source) {
        throw new Error('VOD source URL not available');
      }

      const m3u8Url = await getKickParsedM3u8ForFfmpeg(vodMetadata.source);

      if (!m3u8Url) {
        throw new Error('Failed to parse Kick HLS playlist');
      }

      await convertHlsToMp4(m3u8Url, finalPath, { vodId, isFmp4: false });

      log.info({ vodId, platform }, `Downloaded ${vodId}.mp4`);

      const actualDuration = await getDuration(finalPath);

      if (actualDuration) {
        const client = getClient(tenantId);

        if (client) {
          await finalizeKickChapters(vodId, Math.round(actualDuration), client);
          await client.vod.update({ where: { id: vodId }, data: { duration: Math.round(actualDuration) } });
        }
      }

      await sendVodDownloadSuccess(messageId!, platform, vodId, finalPath, streamerName);

      if (uploadMode) {
        await queueYoutubeUpload(tenantId, vodId, finalPath, uploadMode, platform, log);
      }

      return { success: true, finalPath, durationSeconds: actualDuration ?? undefined };
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
      const { detectFmp4FromPlaylist } = await import('../../utils/ffmpeg.js');
      const isFmp4 = detectFmp4FromPlaylist(m3u8Content);

      await convertHlsToMp4(m3u8Url, finalPath, { vodId, isFmp4 });

      log.info({ vodId, platform }, `Downloaded ${vodId}.mp4`);

      const actualDuration = await getDuration(finalPath);

      if (actualDuration) {
        const client = getClient(tenantId);

        if (client) {
          await saveTwitchVodChapters(vodId, tenantId, Math.round(actualDuration), client);
          await client.vod.update({ where: { id: vodId }, data: { duration: Math.round(actualDuration) } });
        }
      }

      await sendVodDownloadSuccess(messageId!, platform, vodId, finalPath, streamerName);

      if (uploadMode) {
        await queueYoutubeUpload(tenantId, vodId, finalPath, uploadMode, platform, log);
      }

      return { success: true, finalPath, durationSeconds: actualDuration ?? undefined };
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }
  } catch (error) {
    const details = extractErrorDetails(error);
    const errorMsg = details.message.substring(0, 500);

    log.error({ vodId, platform, error: errorMsg }, `Standard VOD download failed`);

    await sendVodDownloadFailed(messageId!, platform, vodId, errorMsg, tenantId);

    throw error;
  }
}
