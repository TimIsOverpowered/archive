import { Processor, Job } from 'bullmq';
import type { DmcaProcessingJob, DmcaProcessingResult } from './jobs/types.js';
import { queueYoutubeVodUpload } from './jobs/youtube.job.js';
import {
  isBlockingPolicy,
  buildMuteFilters,
  muteAudioSections,
  blackoutVideoSections,
  cleanupTempFiles,
  BlackoutSection,
  CLAIM_TYPES,
} from './dmca/dmca.js';
import { trimVideo as ffmpegTrim } from './utils/ffmpeg.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { getJobContext } from './utils/job-context.js';
import { handleWorkerError } from './utils/error-handler.js';
import { fileExists } from '../utils/path.js';
import { initRichAlert, updateAlert } from '../utils/discord-alerts.js';
import { createDmcaWorkerAlerts } from './utils/alert-factories.js';
import { ConfigNotConfiguredError, VodNotFoundError, FileNotFound } from '../utils/domain-errors.js';

const dmcaProcessor: Processor<DmcaProcessingJob, DmcaProcessingResult> = async (job: Job<DmcaProcessingJob>) => {
  const { tenantId, dbId, vodId, receivedClaims, platform, part, filePath: providedFilePath } = job.data;
  const log = createAutoLogger(String(tenantId));

  if (receivedClaims == null || receivedClaims.length === 0) {
    log.warn({ vodId }, 'No claims to process for VOD');

    return { success: true, message: 'No blocking claims found' };
  }

  const { config, db } = await getJobContext(tenantId);

  if (!config.youtube) {
    throw new ConfigNotConfiguredError(`YouTube for tenant ${tenantId}`);
  }

  const vodRecord = await db.selectFrom('vods').where('id', '=', dbId).selectAll().executeTakeFirst();

  if (!vodRecord) {
    throw new VodNotFoundError(dbId, 'dmca worker');
  }

  // Determine file path
  let filePath: string;

  if (providedFilePath != null) {
    // File path provided by route (file already exists)
    filePath = providedFilePath;
    log.info({ vodId, filePath, part }, 'DMCA processing started (file exists)');
  } else {
    // Retrieve file path from download job result (FlowProducer child)
    const childResults = await job.getChildrenValues();
    const downloadResult = Object.values(childResults)[0] as { finalPath?: string };

    if (downloadResult == null || downloadResult.finalPath == null) {
      throw new Error(
        `File path not available for vodId=${vodId}, jobId=${job.id}: ` +
          `download job may have failed or not completed. Child results: ${JSON.stringify(childResults)}`
      );
    }

    filePath = downloadResult.finalPath;
    log.info({ vodId, filePath, part, jobId: job.id }, 'DMCA processing started (file path from download job)');
  }

  // Verify file exists (safety check)
  if (!(await fileExists(filePath))) {
    throw new FileNotFound(filePath);
  }

  // Log processing start with full context
  const blockingClaimsCount = receivedClaims.filter(isBlockingPolicy).length;
  log.info(
    {
      vodId,
      filePath,
      part,
      claimsCount: receivedClaims.length,
      blockingClaimsCount,
      jobId: job.id,
    },
    'Starting DMCA processing'
  );

  const dmcaAlerts = createDmcaWorkerAlerts();
  const messageId = await initRichAlert(dmcaAlerts.processing(vodId, blockingClaimsCount, part));

  const blockingClaims = receivedClaims.filter(isBlockingPolicy);

  if (blockingClaims.length === 0) {
    log.info({ vodId }, 'No blocking claims for VOD, uploading original');
    await updateAlert(messageId, dmcaAlerts.complete(vodId, 'N/A'));

    return { success: true, message: 'No action needed' };
  }

  let processedPath = filePath;
  const tempFiles: string[] = [];

  try {
    if (part != null) {
      const splitDuration = config.youtube.splitDuration ?? 10800;
      const startOffset = splitDuration * (parseInt(String(part)) - 1);

      log.info({ vodId, part }, 'Extracting part from VOD');

      processedPath = await ffmpegTrim(
        filePath,
        startOffset,
        startOffset + splitDuration,
        `${vodId}-part-${part}`,
        () => {}
      );
    }

    const audioClaims = blockingClaims.filter((claim) => claim.type === CLAIM_TYPES.AUDIO);
    const visualClaims = blockingClaims.filter(
      (claim) => claim.type === CLAIM_TYPES.VISUAL || claim.type === CLAIM_TYPES.AUDIOVISUAL
    );

    let intermediateMutedPath: string | null = null;

    if (audioClaims.length > 0) {
      log.info({ vodId, count: audioClaims.length }, 'Processing audio claims');

      const muteFilters = buildMuteFilters(audioClaims);
      const mutedPath = `${processedPath.replace('.mp4', '-muted.mp4')}`;

      intermediateMutedPath = mutedPath;

      const mutedResult = await muteAudioSections(processedPath, muteFilters, mutedPath);

      if (mutedResult == null) {
        throw new Error('Failed to process audio claims');
      }

      processedPath = mutedResult;
    }

    if (visualClaims.length > 0) {
      log.info({ vodId, count: visualClaims.length }, 'Processing visual claims');

      const blackoutSections: BlackoutSection[] = [];

      for (const claim of visualClaims) {
        const startSeconds = claim.matchDetails.longestMatchStartTimeSeconds;
        const durationSeconds = parseInt(claim.matchDetails.longestMatchDurationSeconds) ?? 0;
        const endSeconds = startSeconds + durationSeconds;

        log.info({ vodId, startSeconds, endSeconds }, 'Blackouting section');

        blackoutSections.push({ startSeconds, durationSeconds, endSeconds });
      }

      if (intermediateMutedPath != null && processedPath.endsWith('-muted.mp4')) {
        tempFiles.push(intermediateMutedPath);
      }

      const blackoutedPath = await blackoutVideoSections(processedPath, vodId, blackoutSections);

      if (blackoutedPath == null) {
        throw new Error('Failed to process visual claims');
      }

      processedPath = blackoutedPath;
    }

    log.info({ vodId, part }, 'Queuing YouTube upload');

    const jobId = await queueYoutubeVodUpload(
      { tenantId, config, db },
      dbId,
      vodId,
      processedPath,
      platform,
      'vod',
      undefined,
      part
    );

    if (jobId == null) {
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
