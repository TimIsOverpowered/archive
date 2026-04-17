import type { PrismaClient } from '../../../generated/streamer/client.js';
import type { TenantConfig } from '../../config/types.js';
import type { Platform } from '../../types/platforms.js';
import { getStrategy, type PlatformStreamStatus, type PlatformVodMetadata } from '../../services/platforms/index.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { extractErrorDetails } from '../../utils/error.js';
import { sendStreamOfflineAlert, sendStreamLiveAlert } from './alert-helpers.js';

type StreamerDbClient = PrismaClient;

export async function handlePlatformLiveCheck(prisma: StreamerDbClient, tenantId: string, platform: Platform, config: TenantConfig): Promise<void> {
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

  await handleLiveStream(prisma, streamStatus, platform, platformUserId, platformUsername, config, strategy as NonNullable<ReturnType<typeof getStrategy>>, tenantId, log);
}

async function handleOfflineStream(prisma: PrismaClient, platform: Platform, username: string | undefined, displayName: string | undefined, log: ReturnType<typeof createAutoLogger>): Promise<void> {
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

    await sendStreamOfflineAlert(platform, activeLiveVod.vod_id, activeLiveVod.started_at ?? undefined, username || undefined, displayName);
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
  log.debug({ streamId: streamStatus.id, title: streamStatus.title, startedAt: streamStatus.startedAt }, '[Monitor]: Stream is LIVE');

  const existingVod = await prisma.vod.findFirst({
    where: { stream_id: streamStatus.id, platform },
  });

  if (!existingVod) {
    await handleNewLiveStream(prisma, streamStatus, platform, platformUserId, platformUsername, config, strategy, tenantId, log);
    return;
  }

  if (!existingVod.is_live) {
    await handleExistingVodBecameLive(prisma, existingVod, streamStatus, platform, platformUserId, platformUsername, tenantId, log);
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

  log.info({ vodId: vodMetadata.id, startedAt: streamStatus.startedAt }, '[Monitor]: Creating VOD record for live stream');

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

// Import from stream-detector to avoid duplication
import { enqueueLiveHlsDownload } from './stream-detector.js';
