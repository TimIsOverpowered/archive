import { Processor, Job } from 'bullmq';
import dayjs from 'dayjs';
import utcPlugin from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import path from 'path';

dayjs.extend(utcPlugin);
dayjs.extend(timezone);

import type { DmcaProcessingJob, DmcaProcessingResult, YoutubeUploadJob } from '../jobs/queues.js';
import { getStreamerConfig } from '../config/loader.js';
import { getClient, createClient } from '../db/client.js';
import { getYoutubeUploadQueue } from '../jobs/queues.js';
import type { DMCAClaim } from '../utils/dmca.js';
import { isBlockingPolicy, buildMuteFilters, muteAudioSections, blackoutVideoSections, cleanupTempFiles, BlackoutSection } from '../utils/dmca.js';
import { trimVideo as ffmpegTrim } from '../utils/ffmpeg.js';
import { fileExists } from '../utils/path.js';
import { createAutoLogger as loggerWithTenant } from '../utils/auto-tenant-logger.js';

const dmcaProcessor: Processor<DmcaProcessingJob, DmcaProcessingResult> = async (job: Job<DmcaProcessingJob>) => {
  const { streamerId, vodId, receivedClaims, type, platform, part } = job.data;
  const log = loggerWithTenant(String(streamerId));

  if (!receivedClaims || receivedClaims.length === 0) {
    log.warn(`No claims to process for VOD ${vodId}`);

    return { success: true, message: 'No blocking claims found' };
  }

  const config = getStreamerConfig(streamerId);

  if (!config?.youtube) {
    throw new Error('YouTube not configured for streamer');
  }

  let db = getClient(streamerId);
  if (!db) {
    db = await createClient(config);
  }

  const vodRecord = await db.vod.findUnique({ where: { id: vodId } });

  if (!vodRecord) {
    throw new Error(`VOD not found in database for streamer ${streamerId}`);
  }

  let videoPath: string;

  if (type === 'live') {
    const username = platform === 'twitch' ? config.twitch!.username! : config.kick!.username!;
    const liveDir = path.join(config.settings.livePath!, username, vodRecord.stream_id || vodId);
    videoPath = path.join(liveDir, `${vodRecord.stream_id}.mp4`);
  } else {
    videoPath = path.join(config.settings.vodPath!, streamerId, `${vodId}.mp4`);
  }

  if (!(await fileExists(videoPath))) {
    throw new Error(`Video file not found at ${videoPath}`);
  }

  const blockingClaims = receivedClaims.filter(isBlockingPolicy);

  if (blockingClaims.length === 0) {
    log.info(`No blocking claims for VOD ${vodId}, uploading original`);

    return { success: true, message: 'No action needed' };
  }

  let processedPath = videoPath;
  const tempFiles: string[] = [];

  try {
    if (part) {
      const splitDuration = config.youtube.splitDuration || 10800;
      const startOffset = splitDuration * (parseInt(String(part)) - 1);

      log.info(`Extracting part ${part} from VOD ${vodId}`);

      processedPath = await ffmpegTrim(videoPath, startOffset, startOffset + splitDuration, `${vodId}-part-${part}`, () => {});
    }

    const audioClaims = blockingClaims.filter((claim) => claim.type === 'CLAIM_TYPE_AUDIO');
    const visualClaims = blockingClaims.filter((claim) => claim.type === 'CLAIM_TYPE_VISUAL' || claim.type === 'CLAIM_TYPE_AUDIOVISUAL');

    let intermediateMutedPath: string | null = null;

    if (audioClaims.length > 0) {
      log.info(`Processing ${audioClaims.length} audio claims for VOD ${vodId}`);

      const muteFilters = buildMuteFilters(audioClaims as DMCAClaim[]);
      const mutedPath = `${processedPath.replace('.mp4', '-muted.mp4')}`;

      intermediateMutedPath = mutedPath;

      const mutedResult = await muteAudioSections(processedPath, muteFilters, mutedPath);

      if (!mutedResult) {
        throw new Error('Failed to process audio claims');
      }

      processedPath = mutedResult;
    }

    if (visualClaims.length > 0) {
      log.info(`Processing ${visualClaims.length} visual claims for VOD ${vodId}`);

      const blackoutSections: BlackoutSection[] = [];

      for (const claim of visualClaims as DMCAClaim[]) {
        const startSeconds = claim.matchDetails.longestMatchStartTimeSeconds;
        const durationSeconds = parseInt(claim.matchDetails.longestMatchDurationSeconds) || 0;
        const endSeconds = startSeconds + durationSeconds;

        log.info(`Blackouting ${startSeconds}s-${endSeconds}s for VOD ${vodId}`);

        blackoutSections.push({ startSeconds, durationSeconds, endSeconds });
      }

      if (intermediateMutedPath && processedPath.endsWith('-muted.mp4')) {
        tempFiles.push(intermediateMutedPath);
      }

      const blackoutedPath = await blackoutVideoSections(processedPath, vodId, blackoutSections);

      if (!blackoutedPath) {
        throw new Error('Failed to process visual claims');
      }

      processedPath = blackoutedPath;
    }

    const dateStr = dayjs(vodRecord.created_at)
      .tz(config.settings.timezone || 'UTC')
      .format('MMMM DD YYYY')
      .toUpperCase();

    const platformName = (vodRecord.platform?.toString() || platform).toUpperCase();

    let baseTitle;
    if (type === 'live') {
      baseTitle = `${config.settings.domainName} ${platformName} LIVE VOD - ${dateStr}`;
    } else {
      baseTitle = `${config.settings.domainName} ${platformName} VOD - ${dateStr}`;
    }

    const finalTitle = part ? `${baseTitle} PART ${part}` : baseTitle;

    log.info(`Queuing YouTube upload for ${finalTitle}`);

    const youtubeJobData: YoutubeUploadJob = {
      streamerId,
      vodId: String(vodId),
      filePath: processedPath,
      title: finalTitle,
      description: config.youtube.description || '',
      type: 'vod',
      platform: platform as 'twitch' | 'kick',
      part,
      dmcaProcessed: true,
    };

    const uploadJob = await getYoutubeUploadQueue().add('youtube_upload', youtubeJobData, { jobId: `youtube-dmca_${vodId}` });

    log.info(`YouTube upload job queued with ID ${uploadJob.id!}`);

    return { success: true, youtubeJobId: (uploadJob.id || '').toString(), vodId: String(vodId) };
  } catch (error) {
    log.error(`DMCA processing failed for ${vodId}`);

    throw error;
  } finally {
    await cleanupTempFiles(tempFiles);
  }
};

export default dmcaProcessor;
