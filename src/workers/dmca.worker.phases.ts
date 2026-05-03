import { Job } from 'bullmq';
import type { DmcaProcessingJob } from './jobs/types.js';
import { queueYoutubeVodUpload, queueYoutubeGameUploadByGame } from './jobs/youtube.job.js';
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
import { trimVideo } from './utils/ffmpeg.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { getJobContext } from './utils/job-context.js';
import { fileExists, getVodDirPath } from '../utils/path.js';
import { extractErrorDetails } from '../utils/error.js';
import { initRichAlert } from '../utils/discord-alerts.js';
import { createDmcaWorkerAlerts, DmcaClaimInfo, safeUpdateAlert } from './utils/alert-factories.js';
import { ConfigNotConfiguredError, FileNotFound } from '../utils/domain-errors.js';

import type { TenantConfig } from '../config/types.js';
import type { Kysely } from 'kysely';
import type { StreamerDB } from '../db/streamer-types.js';
import type { AppLogger } from '../utils/logger.js';
import type { Platform, SourceType } from '../types/platforms.js';
import type { DmcaWorkerAlerts } from './utils/alert-factories.js';
import type { DMCAClaim } from './dmca/dmca.js';

export interface DmcaProcessorContext {
  job: Job<DmcaProcessingJob>;
  config: TenantConfig;
  db: Kysely<StreamerDB>;
  tenantId: string;
  dbId: number;
  vodId: string;
  platform: Platform;
  type: SourceType;
  displayName: string;
  filePath: string;
  processedPath: string;
  blockingClaims: DMCAClaim[];
  claimInfos: DmcaClaimInfo[];
  isGameUpload: boolean;
  gameId: number | undefined;
  gameStart: number | undefined;
  gameEnd: number | undefined;
  part: number | undefined;
  log: AppLogger;
  alerts: DmcaWorkerAlerts;
  messageId: string;
  workDir: string;
  tempFiles: string[];
  completedClaimIds: string[];
}

export async function buildDmcaProcessorContext(job: Job<DmcaProcessingJob>): Promise<DmcaProcessorContext> {
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
    type,
  } = job.data;
  const isGameUpload = gameId != null && gameStart != null && gameEnd != null;
  const log = createAutoLogger(String(tenantId));

  const { config, db } = await getJobContext(tenantId);

  if (!config.youtube) {
    throw new ConfigNotConfiguredError(`YouTube for tenant ${tenantId}`);
  }

  let filePath: string;

  if (providedFilePath != null) {
    filePath = providedFilePath;
    log.info({ vodId, filePath, part, gameId, isGameUpload }, 'DMCA processing started (file exists)');
  } else {
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

  if (!(await fileExists(filePath))) {
    throw new FileNotFound(filePath);
  }

  const blockingClaims = receivedClaims.filter(isBlockingPolicy);

  const buildClaimInfo = (claim: (typeof blockingClaims)[0]): DmcaClaimInfo => {
    const startSec = claim.matchDetails.longestMatchStartTimeSeconds ?? 0;
    const durSec = claim.matchDetails.longestMatchDurationSeconds ?? 0;
    return {
      claimId: claim.claimId,
      identifier: getClaimIdentifier(claim),
      startTimestamp: toHHMMSS(startSec),
      endTimestamp: toHHMMSS(startSec + durSec),
      claimType: claim.type,
    };
  };

  const claimInfos: DmcaClaimInfo[] = blockingClaims.map(buildClaimInfo);
  const alerts = createDmcaWorkerAlerts();
  const displayName = config.displayName ?? config.id;
  const messageId = await initRichAlert(alerts.processing(vodId, claimInfos, platform, displayName, part));
  if (messageId == null) {
    throw new Error('Failed to initialize DMCA alert');
  }

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

  return {
    job,
    config,
    db,
    tenantId,
    dbId,
    vodId,
    platform,
    type,
    displayName,
    filePath,
    processedPath: filePath,
    blockingClaims,
    claimInfos,
    isGameUpload,
    gameId,
    gameStart,
    gameEnd,
    part,
    log,
    alerts,
    messageId,
    workDir: getVodDirPath({ config, vodId }),
    tempFiles: [],
    completedClaimIds: [],
  };
}

export async function trimDmcaVideo(ctx: DmcaProcessorContext): Promise<void> {
  if (ctx.part != null && ctx.config.youtube != null) {
    const splitDuration = ctx.config.youtube.splitDuration ?? 10800;
    const startOffset = splitDuration * (parseInt(String(ctx.part)) - 1);

    ctx.log.info({ vodId: ctx.vodId, part: ctx.part }, 'Extracting part from VOD');

    const trimmed = await trimVideo(ctx.filePath, startOffset, splitDuration, `${ctx.vodId}-part-${ctx.part}`);

    if (ctx.processedPath !== ctx.filePath) ctx.tempFiles.push(ctx.processedPath);
    ctx.processedPath = trimmed;
  }

  if (ctx.isGameUpload && ctx.gameStart != null && ctx.gameEnd != null && ctx.gameId != null) {
    ctx.log.info(
      { vodId: ctx.vodId, gameId: ctx.gameId, gameStart: ctx.gameStart, gameEnd: ctx.gameEnd },
      'Trimming VOD to game range'
    );

    const trimmedPath = await trimVideo(
      ctx.processedPath,
      ctx.gameStart,
      ctx.gameEnd,
      `${ctx.vodId}-game-${ctx.gameId}-trimmed`
    );

    if (ctx.processedPath !== ctx.filePath) ctx.tempFiles.push(ctx.processedPath);
    ctx.processedPath = trimmedPath;
  }
}

export async function processDmcaClaims(ctx: DmcaProcessorContext): Promise<void> {
  const audioClaims = ctx.blockingClaims.filter((claim) => claim.type === CLAIM_TYPES.AUDIO);
  const audioVisualClaims = ctx.blockingClaims.filter((claim) => claim.type === CLAIM_TYPES.AUDIOVISUAL);
  const visualClaims = ctx.blockingClaims.filter((claim) => claim.type === CLAIM_TYPES.VISUAL);
  const blackoutClaims = [...visualClaims, ...audioVisualClaims];
  const muteClaims = [...audioClaims, ...audioVisualClaims];
  const muteFilters = muteClaims.length > 0 ? buildMuteFilters(muteClaims) : [];

  const markClaimsCompleted = (claims: typeof ctx.blockingClaims) => {
    for (const claim of claims) {
      const key = claim.claimId ?? getClaimIdentifier(claim);
      if (!ctx.completedClaimIds.includes(key)) {
        ctx.completedClaimIds.push(key);
      }
    }
  };

  const sendAlert = (step: string, progress?: number) => {
    const alertData =
      progress != null
        ? ctx.alerts.progress(
            ctx.vodId,
            ctx.claimInfos,
            ctx.completedClaimIds,
            step,
            ctx.platform,
            ctx.displayName,
            progress
          )
        : ctx.alerts.progress(ctx.vodId, ctx.claimInfos, ctx.completedClaimIds, step, ctx.platform, ctx.displayName);
    safeUpdateAlert(ctx.messageId, alertData, ctx.log, ctx.vodId);
  };

  if (blackoutClaims.length > 0) {
    ctx.log.info(
      {
        vodId: ctx.vodId,
        count: blackoutClaims.length,
        claims: blackoutClaims.map((c) => ({ claimId: c.claimId, identifier: getClaimIdentifier(c) })),
      },
      'Processing visual claims (blackout)'
    );

    const blackoutSections: BlackoutSection[] = [];

    for (const claim of blackoutClaims) {
      const startSeconds = claim.matchDetails.longestMatchStartTimeSeconds ?? 0;
      const durationSeconds = claim.matchDetails.longestMatchDurationSeconds ?? 0;
      const endSeconds = startSeconds + durationSeconds;

      ctx.log.info(
        {
          vodId: ctx.vodId,
          claimId: claim.claimId,
          claimTitle: getClaimIdentifier(claim),
          startSeconds,
          endSeconds,
        },
        'Blackouting section'
      );

      blackoutSections.push({ startSeconds, durationSeconds, endSeconds });
    }

    const blackoutedPath = await blackoutVideoSections(ctx.processedPath, ctx.vodId, blackoutSections, ctx.workDir, {
      onProgress: (pct) => {
        sendAlert('blackout-video', pct);
      },
      onStep: (step, current, total) => {
        sendAlert(`blackout-video [${current}/${total}]: ${step}`);
      },
      audioFilters: muteFilters,
    });

    if (blackoutedPath == null) {
      throw new Error('Failed to process visual claims');
    }

    if (ctx.processedPath !== ctx.filePath) ctx.tempFiles.push(ctx.processedPath);
    ctx.processedPath = blackoutedPath;
    markClaimsCompleted(blackoutClaims);
    if (muteFilters.length > 0) {
      markClaimsCompleted(muteClaims);
    }
    sendAlert('visual-claims-complete');
  } else if (muteClaims.length > 0) {
    ctx.log.info(
      {
        vodId: ctx.vodId,
        count: muteClaims.length,
        claims: muteClaims.map((c) => ({ claimId: c.claimId, identifier: getClaimIdentifier(c) })),
      },
      'Processing audio claims (mute)'
    );

    const mutedPath = `${ctx.processedPath.replace('.mp4', '-muted.mp4')}`;

    const mutedResult = await muteAudioSections(ctx.processedPath, muteFilters, mutedPath, (pct) => {
      sendAlert('mute-audio', pct);
    });

    if (mutedResult == null) {
      throw new Error('Failed to process audio claims');
    }

    if (ctx.processedPath !== ctx.filePath) ctx.tempFiles.push(ctx.processedPath);
    ctx.processedPath = mutedResult;
    markClaimsCompleted(muteClaims);
    sendAlert('mute-complete');
  }
}

export async function queueDmcaUpload(ctx: DmcaProcessorContext): Promise<void> {
  ctx.log.info(
    { vodId: ctx.vodId, part: ctx.part, gameId: ctx.gameId, isGameUpload: ctx.isGameUpload },
    'Queuing YouTube upload'
  );

  if (ctx.isGameUpload && ctx.gameStart != null && ctx.gameEnd != null && ctx.gameId != null) {
    const game = await ctx.db.selectFrom('games').selectAll().where('id', '=', ctx.gameId).executeTakeFirst();
    const gameName = game?.game_name ?? '';
    const gameTitle = game?.title ?? '';

    try {
      await queueYoutubeGameUploadByGame(
        { tenantId: ctx.tenantId, config: ctx.config, db: ctx.db },
        ctx.dbId,
        ctx.vodId,
        ctx.processedPath,
        ctx.platform,
        {
          id: ctx.gameId,
          name: gameName,
          start: ctx.gameStart,
          end: ctx.gameEnd,
          gameId: game?.game_id ?? undefined,
          title: gameTitle,
        }
      );
    } catch (err) {
      ctx.log.warn({ err: extractErrorDetails(err), vodId: ctx.vodId }, 'Game upload queue failed');
    }
  } else {
    try {
      await queueYoutubeVodUpload(
        { tenantId: ctx.tenantId, config: ctx.config, db: ctx.db },
        ctx.dbId,
        ctx.vodId,
        ctx.processedPath,
        ctx.platform,
        'vod',
        true,
        undefined,
        ctx.part
      );
    } catch (err) {
      ctx.log.warn({ err: extractErrorDetails(err), vodId: ctx.vodId }, 'YouTube upload queue failed');
    }
  }
}
