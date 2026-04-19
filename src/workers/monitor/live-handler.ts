import fs from 'fs/promises';
import path from 'path';
import type { PrismaClient } from '../../../generated/streamer/client.js';
import type { TenantConfig } from '../../config/types.js';
import type { Platform } from '../../types/platforms.js';
import { getStrategy, type PlatformStreamStatus, type PlatformVodMetadata } from '../../services/platforms/index.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { extractErrorDetails } from '../../utils/error.js';
import { sendStreamOfflineAlert, sendStreamLiveAlert } from './alert-helpers.js';
import { getLiveDownloadQueue, enqueueJobWithLogging } from '../jobs/queues.js';
import type { LiveDownloadJob } from '../jobs/queues.js';
import { getTenantConfig } from '../../config/loader.js';

type StreamerDbClient = PrismaClient;

export async function handlePlatformLiveCheck(
  prisma: StreamerDbClient,
  tenantId: string,
  platform: Platform,
  config: TenantConfig
): Promise<void> {
  const log = createAutoLogger(tenantId);

  const strategy = getStrategy(platform);
  if (!strategy) {
    log.warn({ platform }, '[Monitor]: No strategy found for platform');
    return;
  }

  const platformUsername = config?.[platform]?.username;
  const platformUserId = config?.[platform]?.id;

  if (!platformUserId || !platformUsername) {
    log.debug({ platform, username: platformUsername }, '[Monitor]: Platform not fully configured');
    return;
  }

  let streamStatus: PlatformStreamStatus | null;

  try {
    const ctx = { tenantId, config, platform } as const;
    streamStatus = await strategy.checkStreamStatus(ctx);
  } catch (error: unknown) {
    const details = extractErrorDetails(error);
    log.warn({ userId: platformUserId, err: details.message }, `[${platform}]: API error - skipping check`);
    return;
  }

  if (!streamStatus) {
    await handleOfflineStream(prisma, platform, platformUsername || undefined, config.displayName, log);
    return;
  }

  await handleLiveStream(
    prisma,
    streamStatus,
    platform,
    platformUserId,
    platformUsername,
    config,
    strategy as NonNullable<ReturnType<typeof getStrategy>>,
    tenantId,
    log
  );
}

async function handleOfflineStream(
  prisma: PrismaClient,
  platform: Platform,
  username: string | undefined,
  displayName: string | undefined,
  log: ReturnType<typeof createAutoLogger>
): Promise<void> {
  log.debug({ username }, '[Monitor]: Streamer is OFFLINE');

  const activeLiveVod = await prisma.vod.findFirst({
    where: { platform, is_live: true },
  });

  if (activeLiveVod) {
    log.info({ vodId: activeLiveVod.vod_id }, '[Monitor]: Marking VOD as ended');

    await prisma.vod.update({
      where: { id: activeLiveVod.id },
      data: { is_live: false },
    });

    await sendStreamOfflineAlert(
      platform,
      activeLiveVod.vod_id,
      activeLiveVod.started_at ?? undefined,
      username || undefined,
      displayName
    );
  } else {
    log.debug('[Monitor]: No active live VOD to update for offline stream');
  }
}

async function handleLiveStream(
  prisma: PrismaClient,
  streamStatus: PlatformStreamStatus,
  platform: Platform,
  platformUserId: string,
  platformUsername: string,
  config: TenantConfig,
  strategy: NonNullable<ReturnType<typeof getStrategy>>,
  tenantId: string,
  log: ReturnType<typeof createAutoLogger>
): Promise<void> {
  log.debug(
    { streamId: streamStatus.id, title: streamStatus.title, startedAt: streamStatus.startedAt },
    '[Monitor]: Stream is LIVE'
  );

  const existingVod = await prisma.vod.findFirst({
    where: { stream_id: streamStatus.id, platform },
  });

  if (!existingVod) {
    await handleNewLiveStream(
      prisma,
      streamStatus,
      platform,
      platformUserId,
      platformUsername,
      config,
      strategy,
      tenantId,
      log
    );
    return;
  }

  if (!existingVod.is_live) {
    await handleExistingVodBecameLive(
      prisma,
      existingVod,
      streamStatus,
      platform,
      platformUserId,
      platformUsername,
      tenantId,
      log
    );
    return;
  }

  await handleAlreadyLiveStream(
    { id: existingVod.id, vod_id: existingVod.vod_id, started_at: existingVod.started_at ?? undefined },
    streamStatus,
    platform,
    platformUserId,
    platformUsername,
    tenantId,
    log
  );
}

async function handleNewLiveStream(
  prisma: PrismaClient,
  streamStatus: PlatformStreamStatus,
  platform: Platform,
  platformUserId: string,
  platformUsername: string,
  config: TenantConfig,
  strategy: NonNullable<ReturnType<typeof getStrategy>>,
  tenantId: string,
  log: ReturnType<typeof createAutoLogger>
): Promise<void> {
  log.info({ streamId: streamStatus.id }, '[Monitor]: New live detected, checking for VOD object');

  const ctx = { tenantId, config, platform };
  let vodMetadata: PlatformVodMetadata | null = null;

  if (strategy.fetchVodObjectForLiveStream) {
    vodMetadata = await strategy.fetchVodObjectForLiveStream(streamStatus.id, ctx);
  }

  if (!vodMetadata) {
    log.debug('[Monitor]: No VOD object found yet');
    return;
  }

  const vodAlreadyExists = await prisma.vod.findFirst({
    where: { vod_id: vodMetadata.id, platform },
  });

  if (vodAlreadyExists) {
    log.debug({ vodId: vodMetadata.id }, '[Monitor]: VOD was created by concurrent poll');
    return;
  }

  log.info(
    { vodId: vodMetadata.id, startedAt: streamStatus.startedAt },
    '[Monitor]: Creating VOD record for live stream'
  );

  const createdVod = await prisma.vod.create({
    data: {
      ...strategy.createVodData(vodMetadata),
      is_live: true,
      started_at: new Date(streamStatus.startedAt),
    },
  });

  await sendStreamLiveAlert(platform, vodMetadata.id, streamStatus.title, platformUsername, config.displayName);

  log.info({ vodId: vodMetadata.id }, '[Monitor]: Queuing HLS download');

  await enqueueLiveHlsDownload({
    dbId: createdVod.id,
    vodId: vodMetadata.id,
    platform,
    tenantId,
    platformUserId,
    platformUsername,
    startedAt: new Date(streamStatus.startedAt),
    sourceUrl: vodMetadata.sourceUrl ?? undefined,
  });
}

async function handleExistingVodBecameLive(
  prisma: PrismaClient,
  existingVod: { id: number; vod_id: string },
  streamStatus: PlatformStreamStatus,
  platform: Platform,
  platformUserId: string,
  platformUsername: string,
  tenantId: string,
  log: ReturnType<typeof createAutoLogger>
): Promise<void> {
  log.info({ vodId: existingVod.vod_id }, '[Monitor]: Existing VOD is now active');

  await prisma.vod.update({
    where: { id: existingVod.id },
    data: {
      is_live: true,
      started_at: new Date(streamStatus.startedAt),
    },
  });

  log.info({ vodId: existingVod.vod_id }, '[Monitor]: Queuing HLS download');

  await enqueueLiveHlsDownload({
    dbId: existingVod.id,
    vodId: existingVod.vod_id,
    platform,
    tenantId,
    platformUserId,
    platformUsername,
    startedAt: new Date(streamStatus.startedAt),
  });
}

async function handleAlreadyLiveStream(
  existingVod: { id: number; vod_id: string; started_at?: Date | null },
  streamStatus: PlatformStreamStatus,
  platform: Platform,
  platformUserId: string,
  platformUsername: string,
  tenantId: string,
  log: ReturnType<typeof createAutoLogger>
): Promise<void> {
  log.debug({ vodId: existingVod.vod_id }, '[Monitor]: VOD is live, ensuring download queued');

  await enqueueLiveHlsDownload({
    dbId: existingVod.id,
    vodId: existingVod.vod_id,
    platform,
    tenantId,
    platformUserId,
    platformUsername,
    startedAt: existingVod.started_at ?? new Date(streamStatus.startedAt),
  });
}

/**
 * Validate that the VOD path exists and is writable before queuing a download job
 */
export async function validateVodPath(tenantId: string): Promise<{ valid: boolean }> {
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

      const testSubdir = path.join(vodDirBase, tenantId);
      try {
        await fs.mkdir(testSubdir, { recursive: true });
        log.trace({ vodPath: vodDirBase }, `[Monitor] VOD path validated successfully`);
        return { valid: true };
      } catch (mkdirError) {
        const details = extractErrorDetails(mkdirError);
        log.error(
          { tenantId, vodPath: testSubdir, error: details.message },
          `[Monitor] Cannot write to VOD path - directory creation failed`
        );
        return { valid: false };
      }
    } catch (accessError) {
      const details = extractErrorDetails(accessError);
      log.error(
        { tenantId, vodPath: vodDirBase, error: details.message },
        `[Monitor] VOD path not accessible - check permissions`
      );
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
export async function enqueueLiveHlsDownload(params: {
  dbId: number;
  vodId: string;
  platform: Platform;
  tenantId: string;
  platformUserId: string;
  platformUsername?: string;
  startedAt: Date;
  sourceUrl?: string;
}): Promise<void> {
  const log = createAutoLogger(params.tenantId);

  const validationResult = await validateVodPath(params.tenantId);
  if (!validationResult.valid) {
    log.error(
      { vodId: params.vodId, platform: params.platform },
      `[Monitor] Aborting download queue - VOD path validation failed`
    );
    return;
  }

  const queue = getLiveDownloadQueue();

  try {
    log.debug(
      { vodId: params.vodId, platform: params.platform, tenantId: params.tenantId },
      `[Monitor] Attempting to enqueue Live HLS download job`
    );

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
        removeOnComplete: true,
        removeOnFail: true,
      },
      { info: log.info.bind(log), debug: log.debug.bind(log) },
      `[Monitor] Live HLS download job enqueued successfully`,
      { dbId: params.dbId, vodId: params.vodId, platform: params.platform, queueName: 'vod_live' }
    );

    if (isNew) {
      log.debug({ vodId: params.vodId, jobId }, `[Monitor] Job was newly added to queue`);
    }
  } catch (error) {
    const details = extractErrorDetails(error);
    log.error({ vodId: params.vodId, ...details }, `[Monitor] CRITICAL - Failed to enqueue Live HLS download job`);
  }
}
