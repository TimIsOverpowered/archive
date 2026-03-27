import { Processor, Job } from 'bullmq';
import fsPromises from 'fs/promises';
import path from 'path';
import { getStreamerConfig } from '../config/loader';
import { getClient, createClient } from '../db/client';
import { downloadM3u8, getDuration } from '../utils/ffmpeg';
import { sendDiscordAlert, updateDiscordMessage, formatProgressMessage, resetFailures, isAlertsEnabled } from '../utils/alerts';
import { getVodTokenSig, getM3u8, getVodData, getChapters } from '../services/twitch';
import { getVod as getKickVod } from '../services/kick';
import { fetchAndSaveEmotes } from '../services/emotes';
import { getChatDownloadQueue, getYoutubeUploadQueue } from '../jobs/queues';

interface VODDownloadJobData {
  streamerId: string;
  vodId: string;
  platform: 'twitch' | 'kick';
  externalVodId?: string;
}

const vodProcessor: Processor<VODDownloadJobData> = async (job: Job<VODDownloadJobData>) => {
  const { streamerId, vodId, platform, externalVodId } = job.data;

  const config = getStreamerConfig(streamerId);
  if (!config) {
    throw new Error(`Stream config not found for ${streamerId}`);
  }

  let db = getClient(streamerId);
  if (!db) {
    db = await createClient(config);
  }

  const messageId = await sendDiscordAlert(`[VOD Download] ${streamerId} Starting...`);

  try {
    const outputDir = path.join(process.cwd(), 'tmp', streamerId);
    await fsPromises.mkdir(outputDir, { recursive: true });

    let vodData: any;
    let m3u8Url: string;
    let twitchChannelId: string | undefined;

    if (platform === 'twitch') {
      if (!externalVodId) throw new Error('Twitch VOD ID is required');

      vodData = await getVodData(externalVodId, streamerId);

      const tokenSig = await getVodTokenSig(externalVodId);
      const m3u8Content = await getM3u8(externalVodId, tokenSig.value, tokenSig.signature);

      const variantMatch = m3u8Content.match(/#EXT-X-STREAM-INF:[^\n]*\n(.+\.m3u8)/);
      if (!variantMatch) {
        throw new Error('Failed to parse Twitch HLS playlist');
      }
      m3u8Url = variantMatch[1];
    } else {
      const kickConfig = config.kick;
      if (!kickConfig?.channelName) {
        throw new Error('Kick channel not configured');
      }

      if (!externalVodId) throw new Error('Kick VOD ID is required');

      const kickVod = await getKickVod(kickConfig.channelName, externalVodId);
      vodData = {
        id: String(kickVod.id),
        title: kickVod.title,
        duration: kickVod.duration,
        published_at: kickVod.published_at,
        thumbnail_url: kickVod.thumbnail?.url || '',
      };

      m3u8Url = kickVod.source || '';
    }

    const outputPath = path.join(outputDir, `${vodId}.mp4`);

    await downloadM3u8(m3u8Url, outputPath, async (percent) => {
      if (messageId && isAlertsEnabled()) {
        const progressMsg = formatProgressMessage('VOD Download', streamerId, percent);
        await updateDiscordMessage(messageId, progressMsg);
      }
    });

    const duration = await getDuration(outputPath);

    await db.vod.upsert({
      where: { id: vodId },
      create: {
        id: vodId,
        title: vodData.title || 'Unknown',
        platform: platform,
        duration: duration,
      },
      update: {
        duration: duration,
      },
    });

    if (platform === 'twitch') {
      if (!externalVodId) throw new Error('Twitch VOD ID is required for chapters');

      const chapters = await getChapters(externalVodId);

      for (const chapter of chapters) {
        await db.chapter.create({
          data: {
            vod_id: vodId,
            start: chapter.start_time,
            end: chapter.end_time || duration,
            name: chapter.title,
            game_id: vodData.game_id,
          },
        });
      }

      if (twitchChannelId) {
        await fetchAndSaveEmotes(streamerId, vodId, 'twitch', twitchChannelId);
      }

      const chatJob = { streamerId, vodId, platform: 'twitch', duration };
      (getChatDownloadQueue() as any).add(chatJob, { id: `chat:${vodId}` });
    } else {
      if (config.kick?.channelName) {
        await fetchAndSaveEmotes(streamerId, vodId, 'kick', config.kick.channelName);
      }
    }

    resetFailures(streamerId);

    const youtubeJob = { streamerId, vodId, filePath: outputPath, title: vodData.title || 'Unknown', description: '', type: 'vod' };
    (getYoutubeUploadQueue() as any).add(youtubeJob, { id: `youtube:${vodId}` });

    if (messageId && isAlertsEnabled()) {
      await updateDiscordMessage(messageId, `[VOD Download] ${streamerId} Complete!`);
    }

    return { success: true, outputPath, duration };
  } catch (error) {
    console.error(`VOD download failed for ${vodId}:`, error);

    if (messageId && isAlertsEnabled()) {
      await updateDiscordMessage(messageId, `[VOD Download] ${streamerId} FAILED: ${(error as Error).message}`);
    }

    throw error;
  }
};

export default vodProcessor;
