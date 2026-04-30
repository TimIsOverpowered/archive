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
  getClaimIdentifier,
} from './dmca/dmca.js';
import { toHHMMSS } from '../utils/formatting.js';
import { trimVideo } from './utils/ffmpeg.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { getJobContext } from './utils/job-context.js';
import { handleWorkerError } from './utils/error-handler.js';
import { fileExists, getVodDirPath } from '../utils/path.js';
import { extractErrorDetails } from '../utils/error.js';
import { initRichAlert, updateAlert } from '../utils/discord-alerts.js';
import { createDmcaWorkerAlerts, DmcaClaimInfo } from './utils/alert-factories.js';
import { ConfigNotConfiguredError, FileNotFound } from '../utils/domain-errors.js';
import { getDisplayName } from '../config/types.js';
import { uploadAndUpsertGame } from './youtube/game-upload-processor.js';
import { buildYoutubeMetadata } from './youtube/metadata-builder.js';

const dmcaProcessor: Processor<DmcaProcessingJob, DmcaProcessingResult> = async (job: Job<DmcaProcessingJob>) => {
  const {
    tenantId,
    dbId,
    vodId,
    receivedClaims,
    platform,
    part,
    filePath: providedFilePath,
    gameId,
    gameStart,
    gameEnd,
  } = job.data;
  const isGameUpload = gameId != null && gameStart != null && gameEnd != null;
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
    log.info({ vodId, filePath, part, gameId, isGameUpload }, 'DMCA processing started (file exists)');
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
    log.info(
      { vodId, filePath, part, gameId, isGameUpload, jobId: job.id },
      'DMCA processing started (file path from download job)'
    );
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
  const displayName = config.displayName ?? config.id;
  const messageId = await initRichAlert(dmcaAlerts.processing(vodId, claimInfos, platform, displayName, part));

  if (blockingClaims.length === 0) {
    log.info({ vodId }, 'No blocking claims for VOD');
    await updateAlert(messageId, dmcaAlerts.complete(vodId, 'N/A', [], platform, displayName));

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
  const tempFiles: string[] = [];
  let ffmpegCmd: string | undefined;
  let currentFfmpegProgress = -1;
  const workDir = getVodDirPath({ config, vodId });

  // Debounced Discord alert updater to avoid spam
  const alertTimer = { current: null as ReturnType<typeof setTimeout> | null };
  const pendingAlert = { current: null as { step: string; progress: number | undefined } | null };
  const formatFfmpegField = (): string => {
    if (ffmpegCmd == null) return '';
    const cmdTruncated = ffmpegCmd.length > 500 ? ffmpegCmd.substring(0, 500) + '...' : ffmpegCmd;
    if (currentFfmpegProgress >= 100) {
      return `✅ Complete\n\`${cmdTruncated}\``;
    }
    const bar =
      '█'.repeat(Math.floor(currentFfmpegProgress / 10)) + '░'.repeat(10 - Math.floor(currentFfmpegProgress / 10));
    return `[${bar}] ${currentFfmpegProgress}%\n\`${cmdTruncated}\``;
  };
  const sendAlertUpdate = () => {
    if (!pendingAlert.current) return;
    const { step, progress } = pendingAlert.current;
    const alertData =
      progress != null
        ? dmcaAlerts.progress(vodId, claimInfos, completedClaimIds, step, platform, displayName, progress)
        : dmcaAlerts.progress(vodId, claimInfos, completedClaimIds, step, platform, displayName);
    if (ffmpegCmd != null) {
      alertData.fields = [...(alertData.fields ?? []), { name: 'Progress', value: formatFfmpegField(), inline: false }];
    }
    void updateAlert(messageId, alertData).catch((err) => {
      log.warn({ err: extractErrorDetails(err) }, 'Discord alert update failed (non-critical)');
    });
  };
  const debouncedAlertUpdate = (currentStep: string, stepProgress?: number) => {
    pendingAlert.current = { step: currentStep, progress: stepProgress };
    if (alertTimer.current != null) {
      clearTimeout(alertTimer.current);
      sendAlertUpdate();
      pendingAlert.current = null;
    }
    alertTimer.current = setTimeout(() => {
      sendAlertUpdate();
      pendingAlert.current = null;
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

      processedPath = await trimVideo(
        filePath,
        startOffset,
        splitDuration,
        `${vodId}-part-${part}`,
        (pct) => {
          currentFfmpegProgress = pct;
        },
        (cmd) => {
          ffmpegCmd = cmd;
          currentFfmpegProgress = 0;
        }
      );
    }

    // For game DMCA: trim VOD to game range before processing
    if (isGameUpload) {
      log.info({ vodId, gameId, gameStart, gameEnd }, 'Trimming VOD to game range');

      const trimmedPath = await trimVideo(
        processedPath,
        gameStart,
        gameEnd,
        `${vodId}-game-${gameId}-trimmed`,
        (pct) => {
          currentFfmpegProgress = pct;
        },
        (cmd) => {
          ffmpegCmd = cmd;
          currentFfmpegProgress = 0;
        }
      );

      if (processedPath !== filePath) tempFiles.push(processedPath);
      processedPath = trimmedPath;
    }

    const audioClaims = blockingClaims.filter((claim) => claim.type === CLAIM_TYPES.AUDIO);
    const audioVisualClaims = blockingClaims.filter((claim) => claim.type === CLAIM_TYPES.AUDIOVISUAL);
    const visualClaims = blockingClaims.filter((claim) => claim.type === CLAIM_TYPES.VISUAL);
    const blackoutClaims = [...visualClaims, ...audioVisualClaims];
    const muteClaims = [...audioClaims, ...audioVisualClaims];
    const muteFilters = muteClaims.length > 0 ? buildMuteFilters(muteClaims) : [];

    if (blackoutClaims.length > 0) {
      log.info(
        {
          vodId,
          count: blackoutClaims.length,
          claims: blackoutClaims.map((c) => ({ claimId: c.claimId, identifier: getClaimIdentifier(c) })),
        },
        'Processing visual claims (blackout)'
      );

      const blackoutSections: BlackoutSection[] = [];

      for (const claim of blackoutClaims) {
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

      const blackoutedPath = await blackoutVideoSections(processedPath, vodId, blackoutSections, workDir, {
        onProgress: (pct) => {
          currentFfmpegProgress = pct;
          debouncedAlertUpdate('blackout-video', pct);
        },
        onStep: (step, current, total) => {
          debouncedAlertUpdate(`blackout-video [${current}/${total}]: ${step}`);
        },
        onStart: (cmd) => {
          ffmpegCmd = cmd;
          currentFfmpegProgress = 0;
        },
        audioFilters: muteFilters,
      });

      if (blackoutedPath == null) {
        throw new Error('Failed to process visual claims');
      }

      if (processedPath !== filePath) tempFiles.push(processedPath);
      processedPath = blackoutedPath;
      markClaimsCompleted(blackoutClaims);
      if (muteFilters.length > 0) {
        markClaimsCompleted(muteClaims);
      }
      debouncedAlertUpdate('visual-claims-complete');
    } else if (muteClaims.length > 0) {
      log.info(
        {
          vodId,
          count: muteClaims.length,
          claims: muteClaims.map((c) => ({ claimId: c.claimId, identifier: getClaimIdentifier(c) })),
        },
        'Processing audio claims (mute)'
      );

      const mutedPath = `${processedPath.replace('.mp4', '-muted.mp4')}`;

      const mutedResult = await muteAudioSections(
        processedPath,
        muteFilters,
        mutedPath,
        (pct) => {
          currentFfmpegProgress = pct;
          debouncedAlertUpdate('mute-audio', pct);
        },
        (cmd) => {
          ffmpegCmd = cmd;
          currentFfmpegProgress = 0;
        }
      );

      if (mutedResult == null) {
        throw new Error('Failed to process audio claims');
      }

      if (processedPath !== filePath) tempFiles.push(processedPath);
      processedPath = mutedResult;
      markClaimsCompleted(muteClaims);
      debouncedAlertUpdate('mute-complete');
    }

    // Flush any pending alert update
    if (alertTimer.current != null) {
      clearTimeout(alertTimer.current);
    }

    log.info({ vodId, part, gameId, isGameUpload }, 'Queuing YouTube upload');

    if (isGameUpload) {
      const game = await db.selectFrom('games').selectAll().where('id', '=', gameId).executeTakeFirst();
      const gameName = game?.game_name ?? '';
      const gameTitle = game?.title ?? '';
      const vodRecord = await db.selectFrom('vods').where('id', '=', dbId).selectAll().executeTakeFirst();

      if (!vodRecord) {
        log.warn({ vodId, dbId }, 'VOD record not found for game upload');
      } else {
        const { title, description } = buildYoutubeMetadata({
          channelName: getDisplayName(config),
          platform,
          domainName: config.settings?.domainName ?? '',
          timezone: config.settings?.timezone ?? 'UTC',
          youtubeDescription: config.youtube?.description,
          gameName: gameTitle,
          vodRecord,
        });

        try {
          await uploadAndUpsertGame({
            tenantId,
            dbId,
            vodId,
            filePath: processedPath,
            chapterStart: gameStart,
            chapterEnd: gameEnd,
            chapterName: gameName,
            chapterGameId: game?.game_id ?? '',
            title,
            description,
            db,
            config,
            log,
          });
        } catch (err) {
          log.warn({ err: extractErrorDetails(err), vodId }, 'Game upload failed');
        }
      }
    } else {
      // VOD upload (existing flow)
      try {
        await queueYoutubeVodUpload(
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
      } catch (err) {
        log.warn({ err: extractErrorDetails(err), vodId }, 'YouTube upload queue failed');
      }
    }

    if (!config.settings.saveMP4) {
      tempFiles.push(filePath);
    }
    return { success: true, vodId };
  } catch (error) {
    const errorMsg = handleWorkerError(error, log, { vodId, dbId, tenantId, jobId: job.id, platform });
    await updateAlert(messageId, dmcaAlerts.error(vodId, errorMsg));

    throw error;
  } finally {
    if (tempFiles.length > 0) {
      await cleanupTempFiles(tempFiles);
    }
    if (alertTimer.current != null) {
      clearTimeout(alertTimer.current);
    }
  }
};

export default dmcaProcessor;
