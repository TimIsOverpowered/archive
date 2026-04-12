// vod.worker.ts
import { Processor, Job } from 'bullmq';
import { convertHlsToMp4 } from './vod/ffmpeg.js';
import { getVodFilePath } from '../utils/path.js';
import { initRichAlert, updateAlert } from '../utils/discord-alerts.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { getKickParsedM3u8ForFfmpeg, getVod } from '../services/kick.js';
import { getVodTokenSig } from '../services/twitch.js';
import { getJobContext } from './job-context.js';
import { queueYoutubeUploads } from './jobs/youtube.job.js';
import { cleanupHlsFiles } from './vod/hls-cleanup.js';
import { downloadHlsStream } from './vod/hls-orchestrator.js';
import { handleWorkerError } from './utils/error-handler.js';
import { createVodWorkerAlerts } from './utils/alert-factories.js';
import type { StandardVodJob } from './jobs/queues.js';

const vodProcessor: Processor<StandardVodJob, unknown, string> = async (job: Job<StandardVodJob, unknown, string>) => {
  const { dbId, vodId, platform, tenantId, uploadMode, downloadMethod = 'hls' } = job.data;
  const log = createAutoLogger(tenantId);

  log.info({ jobId: job.id, dbId, vodId, platform, tenantId }, '[Standard VOD Worker] Starting job');

  const { config } = await getJobContext(tenantId);
  if (!config?.settings.vodPath) throw new Error(`VOD path not configured for ${tenantId}`);

  const finalPath = getVodFilePath({ tenantId, vodId });
  const streamerName = config.displayName || tenantId;
  const alerts = createVodWorkerAlerts();

  const messageId = await initRichAlert(alerts.init(vodId, platform, streamerName));

  try {
    if (downloadMethod === 'ffmpeg') {
      await downloadWithFfmpeg(platform, vodId, finalPath, config, log);
    } else {
      await downloadWithHls(platform, vodId, finalPath, tenantId, config, log);
    }

    log.info({ vodId, platform }, `Downloaded ${vodId}.mp4`);

    await updateAlert(messageId, alerts.complete(vodId, platform, finalPath));

    await queueYoutubeUploads({ tenantId, dbId, vodId, filePath: finalPath, uploadMode, platform, config, log });

    log.info({ jobId: job.id, dbId, vodId, platform, tenantId }, '[Standard VOD Worker] Job completed successfully');
    return { success: true, finalPath };
  } catch (error) {
    const errorMsg = handleWorkerError(error, log, { vodId, platform, jobId: job.id, dbId, tenantId });

    await updateAlert(messageId, alerts.error(vodId, platform, errorMsg));

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
  const sourceUrl = platform === 'kick' ? await getKickSourceUrl(config, vodId) : undefined;

  const result = await downloadHlsStream({
    dbId: 0,
    vodId,
    platform,
    tenantId,
    platformUserId: '',
    sourceUrl,
    isLive: false,
  });

  if (result.finalMp4Path !== finalPath) {
    log.warn({ expected: finalPath, actual: result.finalMp4Path }, 'MP4 path mismatch');
  }

  const shouldKeepHls = config?.settings.saveHLS ?? false;

  await cleanupHlsFiles(result.outputDir, shouldKeepHls, log);
}

async function getKickSourceUrl(config: NonNullable<Awaited<ReturnType<typeof getJobContext>>['config']>, vodId: string): Promise<string | undefined> {
  const username = config?.kick?.username;

  if (!username) {
    throw new Error('Kick username not configured for streamer');
  }

  const vodMetadata = await getVod(username, vodId);

  if (!vodMetadata?.source) {
    throw new Error('VOD source URL not available');
  }

  return vodMetadata.source;
}

export default vodProcessor;
