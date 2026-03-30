import { getTwitchStreamStatus, getLatestTwitchVodObject } from '../services/twitch-live.js';
import { getKickStreamStatus, getLatestKickVodObject } from '../services/kick-live.js';
import { createClient, getClient } from '../db/client.js';
import type { StreamerConfig } from '../config/types.js';
import path from 'path';
import { loggerWithTenant } from '../utils/logger.js';

type PlatformType = 'twitch' | 'kick';

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
  } catch (error: any) {
    const errorMsg = error?.message || String(error);
    let details = errorMsg;

    if (error.response) {
      details += `\nHTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`;
    } else if (error.request) {
      details += '\nNo response received from server';
    }

    const stackTrace = error?.stack ? `\nStack: ${error.stack}` : '';
    log.error({ platform, error }, `[Platform]: ${platform}] Error in stream status check:\n${details}${stackTrace}`);
  }
}

/**
 * Handle Twitch-specific live detection logic - NO FALLBACK, only downloads after VOD object confirmed available
 */
async function handleTwitchLiveCheck(prisma: any, tenantId: string, platform: PlatformType, config: StreamerConfig): Promise<void> {
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
  if (!streamStatus || !Array.isArray(streamStatus.type) || !streamStatus.type.includes('live')) {
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

      // Clean up Redis dedup key for re-downloads later (stream ended = safe to clear)
      await cleanupDedupKey(String(activeLiveVod.id));
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

    // IMMEDIATE check - don't block waiting (legacy pattern!)
    const vodResult = await getLatestTwitchVodObject(userIdCache, streamStatus.id, tenantId);

    if (!vodResult || !vodResult.vodId) {
      log.debug(`[Monitor]: VOD object not ready yet for stream ${streamStatus.id}. Will retry on next poll.`);
      return; // Exit immediately - don't block! Next poll in 30s will check again
    }

    if (vodResult.stream_id !== String(streamStatus.id)) {
      log.debug(`[Monitor]: Latest VOD (${vodResult.vodId}) doesn't match current stream. Will retry on next poll.`);
      return; // Wrong VOD - exit immediately, don't block!
    }

    // Re-check if another concurrent poll already created this record (race guard)
    const vodAlreadyExists = await prisma.vod.findUnique({
      where: { id: vodResult.vodId, platform },
    });

    if (vodAlreadyExists) {
      log.debug(`[Monitor]: VOD ${vodResult.vodId} was created by concurrent poll. Skipping duplicate creation.`);

      // Another instance handling it - nothing more to do here
      return;
    }

    // Safe to create now - no other poll has claimed this stream yet
    log.info(`[Monitor]: Created VOD record ${vodResult.vodId} for live stream. Started at: ${streamStatus.started_at}`);

    await prisma.vod.create({
      data: {
        id: vodResult.vodId, // Permanent Twitch-assigned ID
        platform,
        is_live: true,
        started_at: new Date(streamStatus.started_at),
        title: streamStatus.title || 'Live Stream',
      },
    });

    // Check if download already queued/running before queuing (legacy pattern)
    const hasActiveJob = await checkHasActiveDownload(tenantId, vodResult.vodId);

    if (!hasActiveJob) {
      log.info(`[Monitor]: Queuing HLS download for ${vodResult.vodId}`);

      await enqueueLiveHlsDownload({
        vodId: vodResult.vodId,
        platform,
        streamerId: userIdCache,
        startedAt: new Date(streamStatus.started_at),
      });
    } else {
      log.debug(`[Monitor]: Download already queued/running for ${vodResult.vodId}, skipping.`);
    }
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

    const hasDownloadJob = await checkHasActiveDownload(tenantId, String(existingVod.id));

    if (!hasDownloadJob) {
      log.info(`[Monitor]:  Queuing HLS download for resumed VOD ${String(existingVod.id)}`);

      await enqueueLiveHlsDownload({
        vodId: String(existingVod.id),
        platform,
        streamerId: userIdCache,
        startedAt: new Date(streamStatus.started_at),
      });
    } else {
      log.debug(`[Monitor]:  Download already in progress for VOD ${String(existingVod.id)}`);
    }
  } else if (existingVod && existingVod.is_live) {
    // Already tracked as live with correct fields - no action needed

    log.debug(`[Monitor]:  Already tracking live VOD ${String(existingVod.id)}. No action needed.`);
    return;
  }
}

/**
 * Handle Kick-specific live detection logic - NO FALLBACK, only downloads after video object confirmed available
 */
async function handleKickLiveCheck(prisma: any, tenantId: string, platform: PlatformType, config: StreamerConfig): Promise<void> {
  const log = loggerWithTenant(tenantId);
  const kickUsername = config.kick?.username;

  if (!kickUsername || !config.kick?.enabled) return;

  log.debug(`[Kick]: Checking live status for channel ${kickUsername}...`);

  const streamStatus = await getKickStreamStatus(kickUsername);

  // Streamer is OFFLINE - mark any active live record as ended
  if (!streamStatus || !streamStatus.id || streamStatus.id <= 0) {
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

      // Clean up Redis dedup key for re-downloads later (stream ended = safe to clear)
      await cleanupDedupKey(String(activeLiveVod.id));
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

    // IMMEDIATE check - don't block waiting (legacy pattern!)
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
        id: kickStreamIdStr, // Kick uses single ID throughout lifecycle
        platform,
        is_live: true,
        started_at: new Date(streamStatus.created_at),
        title: vodObject.title || streamStatus.session_title,
      },
    });

    log.info(`[Monitor]: Created Kick VOD record ${kickStreamIdStr}. Started at: ${streamStatus.created_at}`);

    // Check if download already queued/running before queuing (legacy pattern)
    const hasActiveJob = await checkHasActiveDownload(tenantId, kickStreamIdStr);

    if (!hasActiveJob) {
      log.info(`[Monitor]: Queuing HLS download for ${kickStreamIdStr}`);

      await enqueueLiveHlsDownload({
        vodId: kickStreamIdStr,
        platform,
        streamerId: kickUsername,
        startedAt: new Date(streamStatus.created_at),
        sourceUrl: streamStatus.source || undefined,
      });
    } else {
      log.debug(`[Monitor]: Download already queued/running for ${kickStreamIdStr}, skipping.`);
    }
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

    const hasDownloadJob = await checkHasActiveDownload(tenantId, kickStreamIdStr);

    if (!hasDownloadJob) {
      log.info(`[Monitor]:  Queuing HLS download for resumed Kick VOD ${kickStreamIdStr}`);

      await enqueueLiveHlsDownload({
        vodId: kickStreamIdStr,
        platform,
        streamerId: kickUsername,
        startedAt: new Date(streamStatus.created_at),
        sourceUrl: streamStatus.source || undefined,
      });
    } else {
      log.debug(`[Monitor]:  Download already in progress for Kick VOD ${kickStreamIdStr}`);
    }
  } else if (existingVod && existingVod.is_live) {
    // Already tracked as live with correct fields - no action needed

    log.debug(`[Monitor]:  Already tracking live Kick VOD ${kickStreamIdStr}. No action needed.`);
    return;
  }
}

/**
 * Check if a VOD already has an active download running (prevents duplicate jobs)
 */
async function checkHasActiveDownload(tenantId: string, vodId: string): Promise<boolean> {
  const log = loggerWithTenant(tenantId);
  try {
    const fs = await import('fs/promises');

    // Get tenant's vodPath from config to construct correct path
    const streamerConfig = (await import('../config/loader.js')).getStreamerConfig(tenantId);

    if (!streamerConfig?.settings.vodPath) {
      return false;
    }

    const vodDir = path.join(streamerConfig.settings.vodPath, tenantId, vodId); // /mnt/live/{tenant.id}/{vodId}/ structure

    try {
      await fs.access(vodDir);
      log.debug(`[Monitor]:  Download directory exists for VOD ${vodId} - active download detected`);
      return true;
    } catch {
      log.debug(`[Monitor]:  No download directory found for VOD ${vodId}`);
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * Enqueue Live HLS Download job with Redis deduplication check (48-hour TTL)
 */
async function enqueueLiveHlsDownload(params: { vodId: string; platform: PlatformType; streamerId: string; startedAt: Date; sourceUrl?: string }): Promise<void> {
  const log = loggerWithTenant(params.streamerId);
  const Redis = (await import('ioredis')).default;

  // Use global Redis connection for deduplication checks only (not BullMQ queues)
  let redis: any;
  try {
    redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

    const dedupKey = `vod_download:${params.vodId}`;

    // SETNX with 48-hour TTL (172800 seconds) - survives worker restarts during active streams
    const acquired = await redis.set(dedupKey, 'locked', 'EX', 172800, 'NX');

    if (!acquired) {
      log.info(`[${params.vodId}] Download already queued or in progress (Redis dedup lock exists). Skipping.`);
      return; // Another instance is handling this - don't queue duplicate job
    }

    log.info(`[${params.vodId}] Redis dedup key acquired. Enqueuing Live HLS download...`);
  } catch (error: any) {
    log.error(`[Redis] Failed to acquire dedup lock for VOD ${params.vodId}:`, error.message);

    // If Redis fails, still try to queue the job - BullMQ will handle duplicates at worker level
  } finally {
    if (redis && redis.quit) await redis.quit().catch(() => {});
  }

  const { getVODDownloadQueue } = await import('../jobs/queues.js');

  const queue = getVODDownloadQueue();

  try {
    // Note: The worker will handle the actual download logic (Live HLS mode vs one-shot)
    await queue.add(
      'live_hls_download',
      {
        vodId: params.vodId,
        platform: params.platform,
        streamerId: params.streamerId,
        startedAt: params.startedAt.toISOString(),
        sourceUrl: params.sourceUrl || undefined,
      } as any, // Cast to bypass BullMQ type inference for extended job data
      {
        attempts: 3,
        backoff: { type: 'exponential' as const, delay: 5000 },
      } as any // timeout is not in default options but supported by worker-side processing
    );

    log.info(`[${params.vodId}] Live HLS download job enqueued successfully`);
  } catch (error: any) {
    log.error(`[Queue] Failed to enqueue Live HLS download for ${params.vodId}:`, error.message);

    // Release dedup key on failure so it can be retried later
    if (redis?.del) {
      await redis.del(`vod_download:${params.vodId}`).catch(() => {});
    }
  }
}

/**
 * Clean up Redis deduplication key when stream ends or worker completes successfully
 */
async function cleanupDedupKey(vodId: string): Promise<void> {
  const Redis = (await import('ioredis')).default;

  let redis: any;
  try {
    redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

    await redis.del(`vod_download:${vodId}`);

    console.debug(`[Redis] Dedup key cleared for VOD ${vodId} (stream ended or completed)`);
  } catch {
    // Non-critical - just logging
  } finally {
    if (redis && redis.quit) await redis.quit().catch(() => {});
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
    } catch (error: any) {
      log.error(`[Platform]: ${platform}] Error in initial poll cycle:`, error.message || error);
    }
  })();

  const intervalId = setInterval(async () => {
    try {
      await checkPlatformStatus(tenantId, platform, config);
    } catch (error: any) {
      // Prevent one failed poll from crashing the entire loop for this tenant/platform pair
      log.error(`[Platform]: ${platform}] Error in polling cycle:`, error.message || error);
    }
  }, 30_000); // Fixed 30-second polling interval per requirements spec

  // Store interval ID for potential cleanup on shutdown (can be expanded later)
  const key = `${tenantId}:${platform}`;
  if (!(globalThis as any).monitorIntervals) {
    (globalThis as any).monitorIntervals = new Map();
  }
  ((globalThis as any).monitorIntervals as Map<string, NodeJS.Timeout>).set(key, intervalId);

  log.info(`[Platform]: ${platform}] Polling loop started with interval ID: ${intervalId}`);
}

// Export utility function if other modules need it
export { checkHasActiveDownload };
