import fs from 'fs/promises';
import path from 'path';
import { getTenantConfig } from '../../config/loader.js';
import { logger } from '../../utils/logger.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { QUEUE_NAMES, type LiveDownloadJob, getLiveDownloadQueue, enqueueJobWithLogging } from '../../workers/jobs/queues.js';
import { createClient, getClient } from '../../db/client.js';
import type { TenantConfig } from '../../config/types.js';
import { getTwitchStreamStatus, getLatestTwitchVodObject, type TwitchStreamStatus } from '../../services/twitch-live.js';
import { getKickStreamStatus, getLatestKickVodObject } from '../../services/kick-live.js';
import type { KickStreamStatus } from '../../types/kick.js';
import { sendRichAlert } from '../../utils/discord-alerts.js';
import { capitalizePlatform, formatDuration } from '../../utils/formatting.js';
import { extractErrorDetails, createErrorContext } from '../../utils/error.js';

type PlatformType = 'twitch' | 'kick';
type StreamerDbClient = NonNullable<ReturnType<typeof getClient>>;

/**
 * Main polling function - called every 30 seconds per tenant/platform pair
 */
export async function checkPlatformStatus(tenantId: string, platform: PlatformType, config: TenantConfig): Promise<void> {
  const log = createAutoLogger(tenantId);

  log.debug({ platform }, '[Monitor]: Polling platform status for streamer...');
  log.debug({ vodDownload: config.settings?.vodDownload, platformEnabled: config[platform as 'twitch' | 'kick']?.enabled }, '[Monitor]: Config values');

  try {
    const prisma = getClient(tenantId) || (await createClient(config));

    if (platform === 'twitch' && config.twitch?.enabled && config.settings.vodDownload) {
      log.debug({ platform, vodDownload: config.settings.vodDownload }, '[Monitor]: Twitch monitoring enabled');
      await handleTwitchLiveCheck(prisma, tenantId, platform, config);
    } else if (platform === 'kick' && config.kick?.enabled && config.settings.vodDownload) {
      log.debug({ platform, vodDownload: config.settings.vodDownload }, '[Monitor]: Kick monitoring enabled');
      await handleKickLiveCheck(prisma, tenantId, platform, config);
    } else {
      const reasons = [];

      if (platform === 'twitch' && !config.twitch?.enabled) {
        reasons.push('Twitch not enabled');
      }
      if (platform === 'kick' && !config.kick?.enabled) {
        reasons.push(`${platform} not enabled`);
      }
      if (!config.settings.vodDownload) {
        reasons.push('VOD download disabled');
      }

      log.debug({ platform, reasons }, '[Monitor]: Platform monitoring skipped');
    }
  } catch (error: unknown) {
    const details = extractErrorDetails(error);

    if (typeof error === 'object' && error !== null && 'response' in error) {
      log.error({ platform, ...details }, `[${capitalizePlatform(platform)}] Error in stream status check`);
    } else if (typeof error === 'object' && error !== null && 'request' in error) {
      log.error({ platform, ...details }, `[${capitalizePlatform(platform)}] Error in stream status check (no response)`);
    } else {
      log.error({ platform, ...details }, `[${capitalizePlatform(platform)}] Error in stream status check`);
    }
  }
}

/**
 * Handle Twitch-specific live detection logic - NO FALLBACK, only downloads after VOD object confirmed available
 */

async function sendStreamLiveAlert(platform: PlatformType, vodId: string, title: string, username: string, displayName?: string): Promise<void> {
  const streamerName = displayName || username;

  try {
    await sendRichAlert({
      title: '🔴 Stream Going Live',
      description: `${capitalizePlatform(platform)} live stream detected for ${streamerName}`,
      status: 'success',
      fields: [
        { name: 'Platform', value: platform, inline: true },
        { name: 'Streamer', value: `\`${streamerName}\``, inline: true },
        { name: 'Stream ID', value: `\`${vodId}\``, inline: false },
        { name: 'Title', value: title.substring(0, 1024), inline: false },
      ],
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.warn(createErrorContext(error), `Failed to send stream live alert for ${vodId}`);
  }
}

async function sendStreamOfflineAlert(platform: PlatformType, vodId: string, startedAt?: Date, username?: string, displayName?: string): Promise<void> {
  const streamerName = displayName || username;

  try {
    const fields: Array<{ name: string; value: string; inline?: boolean }> = [
      { name: 'Platform', value: platform, inline: true },
      { name: 'Streamer', value: `\`${streamerName}\``, inline: true },
      { name: 'Stream ID', value: `\`${vodId}\``, inline: false },
    ];

    if (startedAt) {
      const durationSeconds = Math.floor((Date.now() - startedAt.getTime()) / 1000);
      fields.push({ name: 'Duration', value: formatDuration(durationSeconds), inline: true });
    }

    await sendRichAlert({
      title: '⚫ Stream Ended',
      description: `${capitalizePlatform(platform)} stream has gone offline for ${streamerName}`,
      status: 'warning',
      fields,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.warn(createErrorContext(error), `Failed to send stream offline alert for ${vodId}`);
  }
}

async function handleTwitchLiveCheck(prisma: StreamerDbClient, tenantId: string, platform: PlatformType, config: TenantConfig): Promise<void> {
  const log = createAutoLogger(tenantId);

  if (!config.twitch?.enabled) return;

  const twitchUsername = config.twitch?.username;
  const twitchId = config.twitch?.id;

  if (!twitchId || !twitchUsername) return;

  log.debug({ username: twitchUsername }, '[Twitch]: Checking live status');

  let streamStatus: TwitchStreamStatus | null;

  try {
    streamStatus = await getTwitchStreamStatus(twitchId, tenantId);
  } catch (error: unknown) {
    const details = extractErrorDetails(error);
    log.warn({ userId: twitchId, err: details.message }, `[Twitch]: API error - skipping offline check`);
    return;
  }

  // Streamer is OFFLINE - mark any active live record as ended
  if (!streamStatus || streamStatus.type !== 'live') {
    log.debug({ username: twitchUsername }, '[Monitor]: Twitch user is OFFLINE');

    const activeLiveVod = await prisma.vod.findFirst({
      where: { platform, is_live: true },
    });

    if (activeLiveVod) {
      log.info({ vodId: activeLiveVod.vod_id }, '[Monitor]: Marking VOD as ended');

      await prisma.vod.update({
        where: { id: activeLiveVod.id },
        data: { is_live: false },
      });

      // Send Discord stream ended alert
      await sendStreamOfflineAlert(platform, activeLiveVod.vod_id, activeLiveVod.started_at ?? undefined, twitchUsername || undefined, config.displayName);
    } else {
      log.debug('[Monitor]: No active live VOD to update for offline stream');
    }

    return; // Nothing more to do - offline handled by worker independently
  }

  // LIVE STREAM DETECTED
  log.debug({ streamId: streamStatus.id, title: streamStatus.title, startedAt: streamStatus.started_at }, '[Twitch]: Stream is LIVE');

  const existingVod = await prisma.vod.findFirst({
    where: { stream_id: streamStatus.id, platform },
  });

  if (!existingVod) {
    log.info({ streamId: streamStatus.id }, '[Monitor]: New Twitch live detected, checking for VOD object');

    const vodResult = await getLatestTwitchVodObject(twitchId, streamStatus.id, tenantId);

    if (!vodResult) {
      log.debug('[Monitor]: No VODs found');
      return; // Exit immediately - don't block! Next poll in 30s will check again
    }

    if (vodResult.stream_id !== String(streamStatus.id)) {
      log.debug({ vodId: vodResult.id, streamId: streamStatus.id }, '[Monitor]: Latest VOD does not match current stream');
      return; // Wrong VOD - exit immediately, don't block!
    }

    // Re-check if another concurrent poll already created this record (race guard)
    const vodAlreadyExists = await prisma.vod.findFirst({
      where: { vod_id: vodResult.id, platform },
    });

    if (vodAlreadyExists) {
      log.debug({ vodId: vodResult.id }, '[Monitor]: VOD was created by concurrent poll');

      // Another instance handling it - nothing more to do here
      return;
    }

    // Safe to create now - no other poll has claimed this stream yet
    log.info({ vodId: vodResult.id, startedAt: streamStatus.started_at }, '[Monitor]: Created VOD record for live stream');

    const createdVod = await prisma.vod.create({
      data: {
        vod_id: vodResult.id,
        platform,
        is_live: true,
        created_at: new Date(vodResult.created_at),
        started_at: new Date(streamStatus.started_at),
        title: vodResult.title,
        stream_id: vodResult.stream_id,
      },
    });

    // Send Discord stream started alert
    await sendStreamLiveAlert(platform, vodResult.id, streamStatus.title || '', twitchUsername, config.displayName);

    log.info({ vodId: vodResult.id }, '[Monitor]: Queuing HLS download');

    await enqueueLiveHlsDownload({
      dbId: createdVod.id,
      vodId: vodResult.id,
      platform,
      tenantId: tenantId,
      platformUserId: twitchId,
      platformUsername: twitchUsername,
      startedAt: new Date(streamStatus.started_at),
    });
  } else if (existingVod && !existingVod.is_live) {
    // Record exists but not marked live - update and queue download

    log.info({ vodId: existingVod.vod_id }, '[Monitor]: Existing VOD is now active, updating fields');

    await prisma.vod.update({
      where: { id: existingVod.id },
      data: {
        is_live: true,
        started_at: new Date(streamStatus.started_at),
        title: existingVod.title,
      },
    });

    log.info({ vodId: existingVod.vod_id }, '[Monitor]: Queuing HLS download');

    await enqueueLiveHlsDownload({
      dbId: existingVod.id,
      vodId: existingVod.vod_id,
      platform,
      tenantId: tenantId,
      platformUserId: twitchId,
      platformUsername: twitchUsername,
      startedAt: new Date(streamStatus.started_at),
    });
  } else if (existingVod && existingVod.is_live) {
    // Already tracked as live - queue download (BullMQ dedup will handle if already queued)
    log.debug({ vodId: existingVod.vod_id }, '[Monitor]: VOD is live, ensuring download is queued');

    await enqueueLiveHlsDownload({
      dbId: existingVod.id,
      vodId: existingVod.vod_id,
      platform,
      tenantId: tenantId,
      platformUserId: twitchId,
      platformUsername: twitchUsername,
      startedAt: existingVod.started_at ?? new Date(streamStatus.started_at),
    });
  }
}

/**
 * Handle Kick-specific live detection logic - NO FALLBACK, only downloads after video object confirmed available
 */
async function handleKickLiveCheck(prisma: StreamerDbClient, tenantId: string, platform: PlatformType, config: TenantConfig): Promise<void> {
  const log = createAutoLogger(tenantId);

  if (!config.kick?.enabled) return;

  const kickUsername = config.kick?.username;
  const kickId = config.kick?.id;

  if (!kickUsername || !kickId) return;

  log.debug({ username: kickUsername }, '[Kick]: Checking live status');

  let streamStatus: KickStreamStatus | null;

  try {
    streamStatus = await getKickStreamStatus(kickUsername);
  } catch (error: unknown) {
    const details = extractErrorDetails(error);
    log.warn({ username: kickUsername, err: details.message }, `[Kick]: API error - skipping offline check`);
    return;
  }

  // Streamer is OFFLINE - mark any active live record as ended
  if (!streamStatus) {
    log.debug({ username: kickUsername }, '[Monitor]: Kick channel is offline');

    const activeLiveVod = await prisma.vod.findFirst({
      where: { platform, is_live: true },
    });

    if (activeLiveVod) {
      log.info({ vodId: activeLiveVod.vod_id }, '[Monitor]: Marking Kick VOD as ended');

      await prisma.vod.update({
        where: { id: activeLiveVod.id },
        data: { is_live: false },
      });

      // Send Discord stream ended alert
      await sendStreamOfflineAlert(platform, activeLiveVod.vod_id, activeLiveVod.started_at ?? undefined, kickUsername || undefined, config.displayName);
    } else {
      log.debug('[Monitor]: No active live Kick VOD to update');
    }

    return; // Nothing more to do - offline handled by worker independently
  }

  log.debug({ streamId: streamStatus.id, title: streamStatus.session_title, startedAt: streamStatus.created_at }, '[Kick]: Stream is LIVE');

  const existingVod = await prisma.vod.findFirst({
    where: { vod_id: streamStatus.id, platform },
  });

  if (!existingVod) {
    log.info({ streamId: streamStatus.id }, '[Monitor]: New Kick live detected, checking for video object');

    const vodObject = await getLatestKickVodObject(kickUsername, streamStatus.id);

    if (!vodObject) {
      log.debug('[Monitor]: No VODs found');
      return; // Exit immediately - don't block! Next poll in 30s will check again
    }

    // Re-check if another concurrent poll already created this record (race guard)
    const vodAlreadyExists = await prisma.vod.findFirst({
      where: { vod_id: vodObject.id, platform },
    });

    if (vodAlreadyExists) {
      log.debug({ vodId: streamStatus.id }, '[Monitor]: VOD was created by concurrent poll');

      // Another instance handling it - nothing more to do here
      return;
    }

    // Safe to create now - no other poll has claimed this stream yet
    const createdVod = await prisma.vod.create({
      data: {
        vod_id: streamStatus.id,
        platform,
        is_live: true,
        created_at: new Date(streamStatus.created_at),
        started_at: new Date(streamStatus.created_at),
        title: streamStatus.session_title,
        stream_id: streamStatus.id,
      },
    });

    log.info({ vodId: vodObject.id, startedAt: streamStatus.created_at }, '[Monitor]: Created Kick VOD record');

    // Send Discord stream started alert
    await sendStreamLiveAlert(platform, vodObject.id, streamStatus.session_title ?? '', kickUsername, config.displayName);

    log.info({ vodId: vodObject.id }, '[Monitor]: Queuing HLS download');

    await enqueueLiveHlsDownload({
      dbId: createdVod.id,
      vodId: streamStatus.id,
      platform,
      tenantId: tenantId,
      platformUserId: kickId,
      platformUsername: kickUsername,
      startedAt: new Date(streamStatus.created_at),
      sourceUrl: vodObject?.source ?? undefined,
    });
  } else if (existingVod && !existingVod.is_live) {
    // Record exists but not marked live - update and queue download

    log.info({ vodId: existingVod.vod_id }, '[Monitor]: Existing Kick VOD is now active, updating fields');

    await prisma.vod.update({
      where: { id: existingVod.id },
      data: {
        is_live: true,
        started_at: new Date(streamStatus.created_at),
        title: streamStatus.session_title,
      },
    });

    log.info({ vodId: existingVod.vod_id }, '[Monitor]: Queuing HLS download');

    const vodObject = await getLatestKickVodObject(kickUsername, existingVod.vod_id);

    await enqueueLiveHlsDownload({
      dbId: existingVod.id,
      vodId: existingVod.vod_id,
      platform,
      tenantId: tenantId,
      platformUserId: kickId,
      platformUsername: kickUsername,
      startedAt: new Date(existingVod.created_at),
      sourceUrl: vodObject?.source ?? undefined,
    });
  } else if (existingVod && existingVod.is_live) {
    // Already tracked as live - queue download (BullMQ dedup will handle if already queued)
    log.info({ vodId: existingVod.vod_id }, '[Monitor]: Kick VOD is live, ensuring download is queued');

    const vodObject = await getLatestKickVodObject(kickUsername, existingVod.vod_id);

    await enqueueLiveHlsDownload({
      dbId: existingVod.id,
      vodId: existingVod.vod_id,
      platform,
      tenantId: tenantId,
      platformUserId: kickId,
      platformUsername: kickUsername,
      startedAt: new Date(existingVod.created_at),
      sourceUrl: vodObject?.source ?? undefined,
    });
  }
}

/**
 * Validate that the VOD path exists and is writable before queuing a download job
 */
async function validateVodPath(tenantId: string): Promise<{ valid: boolean }> {
  const log = createAutoLogger(tenantId);

  try {
    const streamerConfig = getTenantConfig(tenantId);

    if (!streamerConfig?.settings.vodPath) {
      log.error({ tenantId }, `[Monitor] VOD path not configured for tenant - cannot queue downloads`);
      return { valid: false };
    }

    const vodDirBase = streamerConfig.settings.vodPath;

    try {
      await fs.access(vodDirBase, fs.constants.R_OK | fs.constants.W_OK);

      // Verify we can actually create a directory in this path
      const testSubdir = path.join(vodDirBase, tenantId);
      try {
        await fs.mkdir(testSubdir, { recursive: true });
        log.trace({ vodPath: vodDirBase }, `[Monitor] VOD path validated successfully`);
        return { valid: true };
      } catch (mkdirError) {
        const details = extractErrorDetails(mkdirError);
        log.error({ tenantId, vodPath: testSubdir, error: details.message }, `[Monitor] Cannot write to VOD path - directory creation failed`);
        return { valid: false };
      }
    } catch (accessError) {
      const details = extractErrorDetails(accessError);
      log.error({ tenantId, vodPath: vodDirBase, error: details.message }, `[Monitor] VOD path not accessible - check permissions`);
      return { valid: false };
    }
  } catch (error) {
    const details = extractErrorDetails(error);
    log.error({ tenantId, error: details.message }, `[Monitor] Unexpected error validating VOD path`);
    return { valid: false };
  }
}

/**
 * Enqueue Live HLS Download job
 */
async function enqueueLiveHlsDownload(params: {
  dbId: number;
  vodId: string;
  platform: PlatformType;
  tenantId: string;
  platformUserId: string;
  platformUsername?: string;
  startedAt: Date;
  sourceUrl?: string;
}): Promise<void> {
  const log = createAutoLogger(params.tenantId);

  // Validate VOD path before attempting to queue job
  const validationResult = await validateVodPath(params.tenantId);
  if (!validationResult.valid) {
    log.error({ vodId: params.vodId, platform: params.platform }, `[Monitor] Aborting download queue - VOD path validation failed`);
    return; // Don't attempt to queue job if path is invalid
  }

  const queue = getLiveDownloadQueue();

  try {
    log.debug({ vodId: params.vodId, platform: params.platform, tenantId: params.tenantId }, `[Monitor] Attempting to enqueue Live HLS download job`);

    const { jobId, isNew } = await enqueueJobWithLogging(
      queue,
      'live_hls_download',
      {
        dbId: params.dbId,
        vodId: params.vodId,
        platform: params.platform,
        tenantId: params.tenantId,
        platformUserId: params.platformUserId,
        platformUsername: params.platformUsername,
        startedAt: params.startedAt.toISOString(),
        sourceUrl: params.sourceUrl,
      } satisfies LiveDownloadJob,
      {
        jobId: `live_hls_${params.vodId}`,
        attempts: 10,
        backoff: { type: 'exponential' as const, delay: 5000 },
        deduplication: { id: `live_hls_${params.vodId}` },
      },
      { info: log.info.bind(log), debug: log.debug.bind(log) },
      `[Monitor] Live HLS download job enqueued successfully`,
      { dbId: params.dbId, vodId: params.vodId, platform: params.platform, queueName: QUEUE_NAMES.VOD_LIVE }
    );

    if (isNew) {
      log.debug({ vodId: params.vodId, jobId }, `[Monitor] Job was newly added to queue`);
    }
  } catch (error) {
    const details = extractErrorDetails(error);
    log.error({ vodId: params.vodId, ...details }, `[Monitor] CRITICAL - Failed to enqueue Live HLS download job`);
  }
}

/**
 * Start independent polling loop per tenant/platform pair (concurrent async execution)
 */
export function startStreamDetectionLoop(tenantId: string, platform: PlatformType, config: TenantConfig): void {
  const log = createAutoLogger(tenantId);
  log.info(`[${capitalizePlatform(platform)}]: Starting stream detection polling every 30 seconds`);

  // Run immediately on startup, then every 30s
  (async () => {
    try {
      await checkPlatformStatus(tenantId, platform, config);
    } catch (error: unknown) {
      const details = extractErrorDetails(error);
      log.error({ err: details.message }, `[${capitalizePlatform(platform)}] Error in initial poll cycle`);
    }
  })();

  const intervalId = setInterval(async () => {
    try {
      await checkPlatformStatus(tenantId, platform, config);
    } catch (error: unknown) {
      // Prevent one failed poll from crashing the entire loop for this tenant/platform pair
      const details = extractErrorDetails(error);
      log.error({ err: details.message }, `[${capitalizePlatform(platform)}] Error in polling cycle`);
    }
  }, 30_000);

  // Store interval ID for potential cleanup on shutdown (can be expanded later)
  const key = `${tenantId}:${platform}`;

  const globalObj = global as unknown as NodeJS.Global;
  if (!globalObj.monitorIntervals) {
    globalObj.monitorIntervals = new Map();
  }
  globalObj.monitorIntervals.set(key, intervalId);

  log.info({ timeout: 30000 }, `[${capitalizePlatform(platform)}]: Polling loop started`);
}
