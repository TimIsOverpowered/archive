import { Processor, Job } from 'bullmq';
import type { DmcaProcessingJob, DmcaProcessingResult } from './jobs/types.js';
import { queueYoutubeVodUpload } from './jobs/youtube.job.js';
import {
  isBlockingPolicy,
  buildMuteFilters,
  muteAudioSections,
  blackoutVideoSections,
  BlackoutSection,
  CLAIM_TYPES,
  getClaimIdentifier,
} from './dmca/dmca.js';
import { toHHMMSS } from '../utils/formatting.js';
import { trimVideo as ffmpegTrim } from './utils/ffmpeg.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { getJobContext } from './utils/job-context.js';
import { handleWorkerError } from './utils/error-handler.js';
import { fileExists } from '../utils/path.js';
import { extractErrorDetails } from '../utils/error.js';
import { initRichAlert, updateAlert } from '../utils/discord-alerts.js';
import { createDmcaWorkerAlerts, DmcaClaimInfo } from './utils/alert-factories.js';
import { ConfigNotConfiguredError, FileNotFound } from '../utils/domain-errors.js';

const dmcaProcessor: Processor<DmcaProcessingJob, DmcaProcessingResult> = async (job: Job<DmcaProcessingJob>) => {
  const { tenantId, dbId, vodId, receivedClaims, platform, part, filePath: providedFilePath } = job.data;
  const log = createAutoLogger(String(tenantId));

  const { config, db } = await getJobContext(tenantId);

  if (!config.youtube) {
    throw new ConfigNotConfiguredError(`YouTube for tenant ${tenantId}`);
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

  const blockingClaims = receivedClaims.filter(isBlockingPolicy);

  // Build claim info for Discord alerts
  const buildClaimInfo = (claim: (typeof blockingClaims)[0]): DmcaClaimInfo => {
    const startSec = parseInt(String(claim.matchDetails.longestMatchStartTimeSeconds)) ?? 0;
    const durSec = parseInt(claim.matchDetails.longestMatchDurationSeconds) ?? 0;
    return {
      claimId: claim.claimId,
      identifier: getClaimIdentifier(claim),
      startTimestamp: toHHMMSS(startSec),
      endTimestamp: toHHMMSS(startSec + durSec),
      claimType: claim.type,
    };
  };

  const claimInfos: DmcaClaimInfo[] = blockingClaims.map(buildClaimInfo);
  const completedClaimIds: string[] = [];

  const dmcaAlerts = createDmcaWorkerAlerts();
  const messageId = await initRichAlert(dmcaAlerts.processing(vodId, claimInfos, part));

  if (blockingClaims.length === 0) {
    log.info({ vodId }, 'No blocking claims for VOD, uploading original');
    await updateAlert(messageId, dmcaAlerts.complete(vodId, 'N/A', []));

    return { success: true, message: 'No action needed' };
  }

  // Log processing start with full context
  log.info(
    {
      vodId,
      filePath,
      part,
      claimsCount: blockingClaims.length,
      jobId: job.id,
      claims: claimInfos.map((c) => ({
        claimId: c.claimId,
        identifier: c.identifier,
        type: c.claimType,
        range: `${c.startTimestamp}-${c.endTimestamp}`,
      })),
    },
    'Starting DMCA processing'
  );

  let processedPath = filePath;
  let ffmpegCmd: string | undefined;

  // Debounced Discord alert updater to avoid spam
  const alertTimer = { current: null as ReturnType<typeof setTimeout> | null };
  const debouncedAlertUpdate = (currentStep: string, stepProgress?: number) => {
    if (alertTimer.current != null) {
      clearTimeout(alertTimer.current);
    }
    alertTimer.current = setTimeout(() => {
      const alertData = dmcaAlerts.progress(vodId, claimInfos, completedClaimIds, currentStep, stepProgress);
      if (ffmpegCmd != null) {
        alertData.fields = [
          ...(alertData.fields ?? []),
          { name: 'FFmpeg', value: `\`${ffmpegCmd.substring(0, 500)}\``, inline: false },
        ];
      }
      void updateAlert(messageId, alertData).catch((err) => {
        log.warn({ err: extractErrorDetails(err) }, 'Discord alert update failed (non-critical)');
      });
    }, 500);
  };

  const markClaimsCompleted = (claims: typeof blockingClaims) => {
    for (const claim of claims) {
      const key = claim.claimId ?? getClaimIdentifier(claim);
      if (!completedClaimIds.includes(key)) {
        completedClaimIds.push(key);
      }
    }
  };

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
        () => {},
        (cmd) => {
          ffmpegCmd = cmd;
        }
      );
    }

    const audioClaims = blockingClaims.filter((claim) => claim.type === CLAIM_TYPES.AUDIO);
    const audioVisualClaims = blockingClaims.filter((claim) => claim.type === CLAIM_TYPES.AUDIOVISUAL);
    const visualClaims = blockingClaims.filter((claim) => claim.type === CLAIM_TYPES.VISUAL);

    if (visualClaims.length > 0) {
      log.info(
        {
          vodId,
          count: visualClaims.length,
          claims: visualClaims.map((c) => ({ claimId: c.claimId, identifier: getClaimIdentifier(c) })),
        },
        'Processing visual claims (blackout)'
      );

      const blackoutSections: BlackoutSection[] = [];

      for (const claim of visualClaims) {
        const startSeconds = parseInt(String(claim.matchDetails.longestMatchStartTimeSeconds)) ?? 0;
        const durationSeconds = parseInt(claim.matchDetails.longestMatchDurationSeconds) ?? 0;
        const endSeconds = startSeconds + durationSeconds;

        log.info(
          {
            vodId,
            claimId: claim.claimId,
            claimTitle: getClaimIdentifier(claim),
            startSeconds,
            endSeconds,
          },
          'Blackouting section'
        );

        blackoutSections.push({ startSeconds, durationSeconds, endSeconds });
      }

      const blackoutedPath = await blackoutVideoSections(processedPath, vodId, blackoutSections, {
        onProgress: (pct) => {
          debouncedAlertUpdate('blackout-video', pct);
        },
        onStep: (step, current, total) => {
          debouncedAlertUpdate(`blackout-video [${current}/${total}]: ${step}`);
        },
        onStart: (cmd) => {
          ffmpegCmd = cmd;
        },
      });

      if (blackoutedPath == null) {
        throw new Error('Failed to process visual claims');
      }

      processedPath = blackoutedPath;
      markClaimsCompleted(visualClaims);
      debouncedAlertUpdate('visual-claims-complete');
    }

    if (audioVisualClaims.length > 0) {
      log.info(
        {
          vodId,
          count: audioVisualClaims.length,
          claims: audioVisualClaims.map((c) => ({ claimId: c.claimId, identifier: getClaimIdentifier(c) })),
        },
        'Processing audio-visual claims (blackout)'
      );

      const blackoutSections: BlackoutSection[] = [];

      for (const claim of audioVisualClaims) {
        const startSeconds = parseInt(String(claim.matchDetails.longestMatchStartTimeSeconds)) ?? 0;
        const durationSeconds = parseInt(claim.matchDetails.longestMatchDurationSeconds) ?? 0;
        const endSeconds = startSeconds + durationSeconds;

        log.info(
          {
            vodId,
            claimId: claim.claimId,
            claimTitle: getClaimIdentifier(claim),
            startSeconds,
            endSeconds,
          },
          'Blackouting section'
        );

        blackoutSections.push({ startSeconds, durationSeconds, endSeconds });
      }

      const blackoutedPath = await blackoutVideoSections(processedPath, vodId, blackoutSections, {
        onProgress: (pct) => {
          debouncedAlertUpdate('blackout-audiovisual', pct);
        },
        onStep: (step, current, total) => {
          debouncedAlertUpdate(`blackout-av [${current}/${total}]: ${step}`);
        },
        onStart: (cmd) => {
          ffmpegCmd = cmd;
        },
      });

      if (blackoutedPath == null) {
        throw new Error('Failed to process audio-visual claims');
      }

      processedPath = blackoutedPath;
      markClaimsCompleted(audioVisualClaims);
      debouncedAlertUpdate('audiovisual-claims-complete');
    }

    if (audioClaims.length > 0 || audioVisualClaims.length > 0) {
      const muteClaims = [...audioClaims, ...audioVisualClaims];

      log.info(
        {
          vodId,
          count: muteClaims.length,
          claims: muteClaims.map((c) => ({ claimId: c.claimId, identifier: getClaimIdentifier(c) })),
        },
        'Processing audio claims (mute)'
      );

      const muteFilters = buildMuteFilters(muteClaims);
      const mutedPath = `${processedPath.replace('.mp4', '-muted.mp4')}`;

      const mutedResult = await muteAudioSections(
        processedPath,
        muteFilters,
        mutedPath,
        (pct) => {
          debouncedAlertUpdate('mute-audio', pct);
        },
        (cmd) => {
          ffmpegCmd = cmd;
        }
      );

      if (mutedResult == null) {
        throw new Error('Failed to process audio claims');
      }

      processedPath = mutedResult;
      markClaimsCompleted(muteClaims);
      debouncedAlertUpdate('mute-complete');
    }

    // Flush any pending alert update
    if (alertTimer.current != null) {
      clearTimeout(alertTimer.current);
    }

    log.info({ vodId, part }, 'Queuing YouTube upload');

    const jobId = await queueYoutubeVodUpload(
      { tenantId, config, db },
      dbId,
      vodId,
      processedPath,
      platform,
      'vod',
      true,
      undefined,
      part
    );

    if (jobId == null) {
      throw new Error('Failed to queue YouTube upload job');
    }

    log.info({ vodId, jobId }, 'YouTube upload job queued');
    await updateAlert(messageId, dmcaAlerts.complete(vodId, jobId, claimInfos));

    return { success: true, youtubeJobId: jobId, vodId };
  } catch (error) {
    const errorMsg = handleWorkerError(error, log, { vodId, dbId, tenantId, jobId: job.id, platform });
    await updateAlert(messageId, dmcaAlerts.error(vodId, errorMsg));

    throw error;
  } finally {
    if (alertTimer.current != null) {
      clearTimeout(alertTimer.current);
    }
  }
};

export default dmcaProcessor;
