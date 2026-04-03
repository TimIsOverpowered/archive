import fs from 'fs/promises';
import path from 'path';
import { getStreamerConfig } from '../config/loader.js';
import { logger } from '../utils/logger.js';
import { createAutoLogger as loggerWithTenant } from '../utils/auto-tenant-logger.js';
import { QUEUE_NAMES, type LiveHlsDownloadJob, getLiveHlsDownloadQueue } from '../jobs/queues.js';
import { createClient, getClient } from '../db/client.js';
import type { StreamerConfig } from '../config/types.js';
import { getTwitchStreamStatus, getLatestTwitchVodObject } from '../services/twitch-live.js';
import { getKickStreamStatus, getLatestKickVodObject } from '../services/kick-live.js';
import { sendRichAlert } from '../utils/discord-alerts.js';
import { formatDuration } from '../utils/formatting.js';
import { extractErrorDetails, createErrorContext } from '../utils/error.js';

type PlatformType = 'twitch' | 'kick';
type StreamerDbClient = NonNullable<ReturnType<typeof getClient>>;

/**
 * Main polling function - called every 30 seconds per tenant/platform pair
 */
export async function checkPlatformStatus(tenantId: string, platform: PlatformType, config: StreamerConfig): Promise<void> {
  const log = loggerWithTenant(tenantId);

  log.debug(`[Monitor]: Polling ${platform} status for streamer...`);
  log.debug(`[Monitor]: Config values - vodDownload: ${config.settings?.vodDownload}, ${platform}.enabled: ${config[platform as 'twitch' | 'kick']?.enabled}`);

  try {
    const prisma = getClient(tenantId) || (await createClient(config));

    if (platform === 'twitch' && config.twitch?.enabled && config.settings.vodDownload) {
      log.debug(`[Monitor]: Twitch monitoring enabled, VOD download: ${config.settings.vodDownload}`);
      await handleTwitchLiveCheck(prisma, tenantId, platform, config);
    } else if (platform === 'kick' && config.kick?.enabled && config.settings.vodDownload) {
      log.debug(`[Monitor]: Kick monitoring enabled, VOD download: ${config.settings.vodDownload}`);
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

      log.debug(`[Monitor]: ${platform} monitoring skipped: ${reasons.join(', ')}`);
    }
  } catch (error: unknown) {
    const details = extractErrorDetails(error);

    if (typeof error === 'object' && error !== null && 'response' in error) {
      log.error({ platform, ...details }, `[Platform]: ${platform}] Error in stream status check`);
    } else if (typeof error === 'object' && error !== null && 'request' in error) {
      log.error({ platform, ...details }, `[Platform]: ${platform}] Error in stream status check (no response)`);
    } else {
      log.error({ platform, ...details }, `[Platform]: ${platform}] Error in stream status check`);
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
      description: `${platform.toUpperCase()} live stream detected for ${streamerName}`,
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
      description: `${platform.toUpperCase()} stream has gone offline for ${streamerName}`,
      status: 'warning',
      fields,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.warn(createErrorContext(error), `Failed to send stream offline alert for ${vodId}`);
  }
}

async function handleTwitchLiveCheck(prisma: StreamerDbClient, tenantId: string, platform: PlatformType, config: StreamerConfig): Promise<void> {
  const log = loggerWithTenant(tenantId);
  const twitchUsername = config.twitch?.username;

  if (!twitchUsername || !config.twitch?.enabled) return;

  let userIdCache: string | null = null;

  if (config.twitch?.id) {
    userIdCache = String(config.twitch.id);
  } else if (twitchUsername.startsWith('!')) {
    userIdCache = twitchUsername.slice(1);
  } else {
    log.warn(`[Monitor]: No Twitch user_id available for channel ${twitchUsername}. Skipping check.`);
    return;
  }

  if (!userIdCache) return;

  log.debug(`[Twitch]: Checking live status for user_id: ${userIdCache}`);

  const streamStatus = await getTwitchStreamStatus(userIdCache, tenantId);

  // Streamer is OFFLINE - mark any active live record as ended
  if (!streamStatus || streamStatus.type !== 'live') {
    log.debug(`[Monitor]: Twitch user ${userIdCache} is OFFLINE`);

    const activeLiveVod = await prisma.vod.findFirst({
      where: { platform, is_live: true },
    });

    if (activeLiveVod) {
      log.info(`[Monitor]:  Marking VOD ${String(activeLiveVod.id)} as ended`);

      await prisma.vod.update({
        where: { id: String(activeLiveVod.id) },
        data: { is_live: false },
      });

      // Send Discord stream ended alert
      const twitchUsername = config.twitch?.username;
      await sendStreamOfflineAlert(platform, String(activeLiveVod.id), activeLiveVod.started_at ?? undefined, twitchUsername || undefined, config.displayName);
    } else {
      log.debug(`[Monitor]:  No active live VOD to update for offline stream`);
    }

    return; // Nothing more to do - offline handled by worker independently
  }

  // LIVE STREAM DETECTED
  log.debug(`[Twitch]: Stream is LIVE - ID: ${streamStatus.id}, Title: "${streamStatus.title}", Started: ${streamStatus.started_at}`);

  const existingVod = await prisma.vod.findUnique({
    where: { id: String(streamStatus.id), platform },
  });

  if (!existingVod) {
    log.info(`[Monitor]: New Twitch live detected! Stream ID: ${streamStatus.id}. Checking for VOD object...`);

    const vodResult = await getLatestTwitchVodObject(userIdCache, streamStatus.id, tenantId);

    if (!vodResult || !vodResult.id) {
      log.debug(`[Monitor]: VOD object not ready yet for stream ${streamStatus.id}. Will retry on next poll.`);
      return; // Exit immediately - don't block! Next poll in 30s will check again
    }

    if (vodResult.stream_id !== String(streamStatus.id)) {
      log.debug(`[Monitor]: Latest VOD (${vodResult.id}) doesn't match current stream. Will retry on next poll.`);
      return; // Wrong VOD - exit immediately, don't block!
    }

    // Re-check if another concurrent poll already created this record (race guard)
    const vodAlreadyExists = await prisma.vod.findUnique({
      where: { id: vodResult.id, platform },
    });

    if (vodAlreadyExists) {
      log.debug(`[Monitor]: VOD ${vodResult.id} was created by concurrent poll. Skipping duplicate creation.`);

      // Another instance handling it - nothing more to do here
      return;
    }

    // Safe to create now - no other poll has claimed this stream yet
    log.info(`[Monitor]: Created VOD record ${vodResult.id} for live stream. Started at: ${streamStatus.started_at}`);

    await prisma.vod.create({
      data: {
        id: vodResult.id, // Permanent Twitch-assigned ID
        platform,
        is_live: true,
        created_at: new Date(vodResult.created_at),
        started_at: new Date(streamStatus.started_at),
        title: streamStatus.title || 'Live Stream',
        stream_id: vodResult.stream_id,
      },
    });

    // Send Discord stream started alert
    await sendStreamLiveAlert(platform, vodResult.id, streamStatus.title || 'Live Stream', twitchUsername, config.displayName);

    log.info(`[Monitor]: Queuing HLS download for ${vodResult.id}`);

    await enqueueLiveHlsDownload({
      vodId: vodResult.id,
      platform,
      tenantId: tenantId,
      platformUserId: userIdCache,
      platformUsername: twitchUsername,
      startedAt: new Date(streamStatus.started_at),
    });
  } else if (existingVod && !existingVod.is_live) {
    // Record exists but not marked live - update and queue download

    log.info(`[Monitor]:  Existing VOD ${String(existingVod.id)} is now active. Updating fields...`);

    await prisma.vod.update({
      where: { id: existingVod.id },
      data: {
        is_live: true,
        started_at: new Date(streamStatus.started_at),
        title: streamStatus.title || existingVod.title,
      },
    });

    // [CRASH RECOVERY] Check for crash recovery scenario - partial segments exist from previous run?
    const hasPartialSegments = await checkForCrashRecovery(tenantId, String(existingVod.id));

    if (hasPartialSegments) {
      log.info({ vodId: existingVod.id }, `[Monitor]: Crash detected for ${existingVod.id} - resuming download`);
    }

    log.info(`[Monitor]:  Queuing HLS download for resumed VOD ${String(existingVod.id)}`);

    await enqueueLiveHlsDownload({
      vodId: String(existingVod.id),
      platform,
      tenantId: tenantId,
      platformUserId: userIdCache,
      platformUsername: twitchUsername,
      startedAt: new Date(streamStatus.started_at),
    });
  } else if (existingVod && existingVod.is_live) {
    // Already tracked as live - queue download (BullMQ dedup will handle if already queued)
    log.info(`[Monitor]: VOD ${String(existingVod.id)} is live - ensuring download is queued`);

    await enqueueLiveHlsDownload({
      vodId: String(existingVod.id),
      platform,
      tenantId: tenantId,
      platformUserId: userIdCache,
      platformUsername: twitchUsername,
      startedAt: existingVod.started_at ?? new Date(),
    });
  }
}

/**
 * Handle Kick-specific live detection logic - NO FALLBACK, only downloads after video object confirmed available
 */
async function handleKickLiveCheck(prisma: StreamerDbClient, tenantId: string, platform: PlatformType, config: StreamerConfig): Promise<void> {
  const log = loggerWithTenant(tenantId);
  const kickUsername = config.kick?.username;

  if (!kickUsername || !config.kick?.enabled) return;

  log.debug(`[Kick]: Checking live status for channel ${kickUsername}...`);

  const streamStatus = await getKickStreamStatus(kickUsername);

  // Streamer is OFFLINE - mark any active live record as ended
  if (!streamStatus || !streamStatus.id) {
    log.debug(`[Monitor]: Kick channel ${kickUsername} is offline`);

    const activeLiveVod = await prisma.vod.findFirst({
      where: { platform, is_live: true },
    });

    if (activeLiveVod) {
      log.info(`[Monitor]:  Marking Kick VOD ${String(activeLiveVod.id)} as ended`);

      await prisma.vod.update({
        where: { id: String(activeLiveVod.id) },
        data: { is_live: false },
      });

      // Send Discord stream ended alert
      const kickUsername = config.kick?.username;
      await sendStreamOfflineAlert(platform, String(activeLiveVod.id), activeLiveVod.started_at ?? undefined, kickUsername || undefined, config.displayName);
    } else {
      log.debug(`[Monitor]:  No active live Kick VOD to update`);
    }

    return; // Nothing more to do - offline handled by worker independently
  }

  // LIVE STREAM DETECTED on Kick
  const kickStreamIdStr = String(streamStatus.id);

  log.debug(`[Kick]: Stream is LIVE - ID: ${kickStreamIdStr}, Title: "${streamStatus.session_title}", Started: ${streamStatus.created_at}`);

  const existingVod = await prisma.vod.findUnique({
    where: { id: kickStreamIdStr, platform },
  });

  if (!existingVod) {
    log.info(`[Monitor]: New Kick live detected! Stream ID: ${kickStreamIdStr}. Checking for video object...`);

    const vodObject = await getLatestKickVodObject(kickUsername, streamStatus.id);

    if (!vodObject || !vodObject.id) {
      log.debug(`[Monitor]: Video object not ready yet for Kick stream ${kickStreamIdStr}. Will retry on next poll.`);
      return; // Exit immediately - don't block! Next poll in 30s will check again
    }

    // Re-check if another concurrent poll already created this record (race guard)
    const vodAlreadyExists = await prisma.vod.findUnique({
      where: { id: kickStreamIdStr, platform },
    });

    if (vodAlreadyExists) {
      log.debug(`[Monitor]: VOD ${kickStreamIdStr} was created by concurrent poll. Skipping duplicate creation.`);

      // Another instance handling it - nothing more to do here
      return;
    }

    // Safe to create now - no other poll has claimed this stream yet
    await prisma.vod.create({
      data: {
        id: vodObject.id,
        platform,
        is_live: true,
        created_at: new Date(streamStatus.created_at),
        started_at: new Date(streamStatus.created_at),
        title: streamStatus.session_title,
        stream_id: kickStreamIdStr,
      },
    });

    log.info(`[Monitor]: Created Kick VOD record ${kickStreamIdStr}. Started at: ${streamStatus.created_at}`);

    // Send Discord stream started alert
    await sendStreamLiveAlert(platform, kickStreamIdStr, streamStatus.session_title || 'Live Stream', kickUsername, config.displayName);

    log.info(`[Monitor]: Queuing HLS download for ${kickStreamIdStr}`);

    await enqueueLiveHlsDownload({
      vodId: kickStreamIdStr,
      platform,
      tenantId: tenantId,
      platformUserId: kickUsername,
      platformUsername: kickUsername,
      startedAt: new Date(streamStatus.created_at),
      sourceUrl: vodObject?.source ?? streamStatus.playback_url ?? undefined,
    });
  } else if (existingVod && !existingVod.is_live) {
    // Record exists but not marked live - update and queue download

    log.info(`[Monitor]:  Existing Kick VOD ${kickStreamIdStr} is now active. Updating fields...`);

    await prisma.vod.update({
      where: { id: existingVod.id },
      data: {
        is_live: true,
        started_at: new Date(streamStatus.created_at),
        title: streamStatus.session_title || existingVod.title,
      },
    });

    // [CRASH RECOVERY] Check for crash recovery scenario - partial segments exist from previous run?
    const hasPartialSegments = await checkForCrashRecovery(tenantId, kickStreamIdStr);

    if (hasPartialSegments) {
      log.info({ vodId: kickStreamIdStr }, `[Monitor]: Crash detected for ${kickStreamIdStr} - resuming download`);
    }

    log.info(`[Monitor]:  Queuing HLS download for resumed VOD ${String(existingVod.id)}`);

    const vodObject = await getLatestKickVodObject(kickUsername, existingVod.id);

    await enqueueLiveHlsDownload({
      vodId: String(existingVod.id),
      platform,
      tenantId: tenantId,
      platformUserId: kickUsername,
      platformUsername: kickUsername,
      startedAt: new Date(existingVod.created_at),
      sourceUrl: vodObject?.source ?? undefined,
    });
  } else if (existingVod && existingVod.is_live) {
    // Already tracked as live - queue download (BullMQ dedup will handle if already queued)
    log.info(`[Monitor]: Kick VOD ${kickStreamIdStr} is live - ensuring download is queued`);

    const vodObject = await getLatestKickVodObject(kickUsername, existingVod.id);

    await enqueueLiveHlsDownload({
      vodId: kickStreamIdStr,
      platform,
      tenantId: tenantId,
      platformUserId: kickUsername,
      platformUsername: kickUsername,
      startedAt: existingVod.started_at ?? new Date(),
      sourceUrl: vodObject?.source ?? undefined,
    });
  }
}

/**
 * Validate that the VOD path exists and is writable before queuing a download job
 */
async function validateVodPath(tenantId: string): Promise<{ valid: boolean }> {
  const log = loggerWithTenant(tenantId);

  try {
    const streamerConfig = getStreamerConfig(tenantId);

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
  vodId: string;
  platform: PlatformType;
  tenantId: string;
  platformUserId: string;
  platformUsername?: string;
  startedAt: Date;
  sourceUrl?: string;
}): Promise<void> {
  const log = loggerWithTenant(params.tenantId);

  // Validate VOD path before attempting to queue job
  const validationResult = await validateVodPath(params.tenantId);
  if (!validationResult.valid) {
    log.error({ vodId: params.vodId, platform: params.platform }, `[Monitor] Aborting download queue - VOD path validation failed`);
    return; // Don't attempt to queue job if path is invalid
  }

  const queue = getLiveHlsDownloadQueue();

  try {
    log.info({ vodId: params.vodId, platform: params.platform, tenantId: params.tenantId }, `[Monitor] Attempting to enqueue Live HLS download job`);

    const job = await queue.add(
      'live_hls_download',
      {
        vodId: params.vodId,
        platform: params.platform,
        tenantId: params.tenantId,
        platformUserId: params.platformUserId,
        platformUsername: params.platformUsername,
        startedAt: params.startedAt.toISOString(),
        sourceUrl: params.sourceUrl,
      } satisfies LiveHlsDownloadJob,
      {
        jobId: `live_hls_${params.vodId}`,
        attempts: 10,
        backoff: { type: 'exponential' as const, delay: 5000 },
        deduplication: { id: `live_hls_${params.vodId}` },
      }
    );

    log.info({ vodId: params.vodId, jobId: String(job.id), platform: params.platform, queueName: QUEUE_NAMES.VOD_DOWNLOAD }, `[Monitor] Live HLS download job enqueued successfully`);
  } catch (error) {
    const details = extractErrorDetails(error);
    log.error({ vodId: params.vodId, ...details }, `[Monitor] CRITICAL - Failed to enqueue Live HLS download job`);
  }
}

/**
 * Check if a crash occurred mid-download by scanning for partial segments on disk
 */
async function checkForCrashRecovery(tenantId: string, vodId: string): Promise<boolean> {
  const log = loggerWithTenant(tenantId);

  try {
    const streamerConfig = getStreamerConfig(tenantId);

    if (!streamerConfig?.settings.vodPath) {
      return false;
    }

    const vodDir = path.join(streamerConfig.settings.vodPath, tenantId, vodId);

    // Check if directory exists (indicates download was in progress when crash occurred)
    try {
      await fs.access(vodDir);

      // Scan for segments - if any exist but no final MP4, this is a crash recovery scenario
      const files = await fs.readdir(vodDir);
      const hasSegments = files.some((f) => f.endsWith('.ts') || (f.endsWith('.mp4') && !f.includes('_final.mp4')));

      return hasSegments;
    } catch {
      // Directory doesn't exist - no crash to recover from
      return false;
    }
  } catch (error) {
    log.warn(createErrorContext(error, { vodId }), `Failed to check for crash recovery`);
    return false;
  }
}

/**
 * Start independent polling loop per tenant/platform pair (concurrent async execution)
 */
export function startStreamDetectionLoop(tenantId: string, platform: PlatformType, config: StreamerConfig): void {
  const log = loggerWithTenant(tenantId);
  log.info(`[Platform]: ${platform}] Starting stream detection polling every 30 seconds...`);

  // Run immediately on startup, then every 30s
  (async () => {
    try {
      await checkPlatformStatus(tenantId, platform, config);
    } catch (error: unknown) {
      const details = extractErrorDetails(error);
      log.error({ err: details.message }, `[Platform]: ${platform}] Error in initial poll cycle`);
    }
  })();

  const intervalId = setInterval(async () => {
    try {
      await checkPlatformStatus(tenantId, platform, config);
    } catch (error: unknown) {
      // Prevent one failed poll from crashing the entire loop for this tenant/platform pair
      const details = extractErrorDetails(error);
      log.error({ err: details.message }, `[Platform]: ${platform}] Error in polling cycle`);
    }
  }, 30_000);

  // Store interval ID for potential cleanup on shutdown (can be expanded later)
  const key = `${tenantId}:${platform}`;

  const globalObj = global as unknown as NodeJS.Global;
  if (!globalObj.monitorIntervals) {
    globalObj.monitorIntervals = new Map();
  }
  globalObj.monitorIntervals.set(key, intervalId);

  log.info(`[Platform]: ${platform}] Polling loop started with interval ID: ${intervalId}`);
}
