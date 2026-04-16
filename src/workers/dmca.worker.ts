import { Processor, Job } from 'bullmq';
import type { DmcaProcessingJob, DmcaProcessingResult } from './jobs/queues.js';
import { queueYoutubeVodUpload } from './jobs/youtube.job.js';
import type { DMCAClaim } from '../utils/dmca.js';
import { isBlockingPolicy, buildMuteFilters, muteAudioSections, blackoutVideoSections, cleanupTempFiles, BlackoutSection } from '../utils/dmca.js';
import { trimVideo as ffmpegTrim } from './vod/ffmpeg.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { getJobContext } from './utils/job-context.js';
import { handleWorkerError } from './utils/error-handler.js';
import { triggerVodDownload } from './jobs/vod.job.js';
import { getVodFilePath, fileExists } from '../utils/path.js';
import { getStandardVodQueue } from './jobs/queues.js';
import { initRichAlert, updateAlert } from '../utils/discord-alerts.js';
import { createDmcaWorkerAlerts } from './utils/alert-factories.js';
import type { Platform } from '../types/platforms.js';
import { SOURCE_TYPES } from '../types/platforms.js';

const dmcaProcessor: Processor<DmcaProcessingJob, DmcaProcessingResult> = async (job: Job<DmcaProcessingJob>) => {
  const { tenantId, dbId, vodId, receivedClaims, type, platform, part } = job.data;
  const log = createAutoLogger(String(tenantId));

  if (!receivedClaims || receivedClaims.length === 0) {
    log.warn({ vodId }, 'No claims to process for VOD');

    return { success: true, message: 'No blocking claims found' };
  }

  const { config, db } = await getJobContext(tenantId);

  if (!config.youtube) {
    throw new Error(`YouTube not configured for tenant ${tenantId}`);
  }

  const vodRecord = await db.vod.findUnique({ where: { id: dbId } });

  if (!vodRecord) {
    throw new Error(`VOD not found in database for streamer ${tenantId}`);
  }

  // For live streams, use stream_id; for archived, use vod_id
  const fileIdentifier = type === SOURCE_TYPES.LIVE ? vodRecord.stream_id || vodId : vodId;

  const filePath = getVodFilePath({ config, vodId: fileIdentifier });

  if (!(await fileExists(filePath))) {
    const existingJob = await getStandardVodQueue().getJob(`vod_${fileIdentifier}`);
    if (!existingJob) {
      const platformUserId = config?.[platform]?.id;
      const platformUsername = config?.[platform]?.username;

      if (!platformUserId || !platformUsername) {
        throw new Error(`Platform ${platform} not configured for tenant ${tenantId}`);
      }

      await triggerVodDownload(tenantId, vodRecord.id, fileIdentifier, platform, platformUserId, platformUsername);
      log.info({ vodId: fileIdentifier }, 'VOD download queued, DMCA job will retry');
    } else {
      log.debug({ vodId: fileIdentifier, state: await existingJob.getState() }, 'VOD download already in progress');
    }
    throw new Error('VOD not yet downloaded, retrying');
  }

  const videoPath = filePath;

  const dmcaAlerts = createDmcaWorkerAlerts();
  const blockingClaimsCount = receivedClaims.filter(isBlockingPolicy).length;
  const messageId = await initRichAlert(dmcaAlerts.processing(vodId, blockingClaimsCount, part));

  const blockingClaims = receivedClaims.filter(isBlockingPolicy);

  if (blockingClaims.length === 0) {
    log.info({ vodId }, 'No blocking claims for VOD, uploading original');
    await updateAlert(messageId, dmcaAlerts.complete(vodId, 'N/A'));

    return { success: true, message: 'No action needed' };
  }

  let processedPath = videoPath;
  const tempFiles: string[] = [];

  try {
    if (part) {
      const splitDuration = config.youtube.splitDuration || 10800;
      const startOffset = splitDuration * (parseInt(String(part)) - 1);

      log.info({ vodId, part }, 'Extracting part from VOD');

      processedPath = await ffmpegTrim(videoPath, startOffset, startOffset + splitDuration, `${vodId}-part-${part}`, () => {});
    }

    const audioClaims = blockingClaims.filter((claim) => claim.type === 'CLAIM_TYPE_AUDIO');
    const visualClaims = blockingClaims.filter((claim) => claim.type === 'CLAIM_TYPE_VISUAL' || claim.type === 'CLAIM_TYPE_AUDIOVISUAL');

    let intermediateMutedPath: string | null = null;

    if (audioClaims.length > 0) {
      log.info({ vodId, count: audioClaims.length }, 'Processing audio claims');

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
      log.info({ vodId, count: visualClaims.length }, 'Processing visual claims');

      const blackoutSections: BlackoutSection[] = [];

      for (const claim of visualClaims as DMCAClaim[]) {
        const startSeconds = claim.matchDetails.longestMatchStartTimeSeconds;
        const durationSeconds = parseInt(claim.matchDetails.longestMatchDurationSeconds) || 0;
        const endSeconds = startSeconds + durationSeconds;

        log.info({ vodId, startSeconds, endSeconds }, 'Blackouting section');

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

    log.info({ vodId, part }, 'Queuing YouTube upload');

    const jobId = await queueYoutubeVodUpload({ tenantId, config, db }, dbId, vodId, processedPath, platform as Platform);

    if (!jobId) {
      throw new Error('Failed to queue YouTube upload job');
    }

    log.info({ vodId, jobId }, 'YouTube upload job queued');
    await updateAlert(messageId, dmcaAlerts.complete(vodId, jobId));

    return { success: true, youtubeJobId: jobId, vodId };
  } catch (error) {
    const errorMsg = handleWorkerError(error, log, { vodId, dbId, tenantId, jobId: job.id, platform });
    await updateAlert(messageId, dmcaAlerts.error(vodId, errorMsg));

    throw error;
  } finally {
    await cleanupTempFiles(tempFiles);
  }
};

export default dmcaProcessor;
