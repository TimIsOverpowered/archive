import fs from 'fs/promises';
import path from 'path';
import type { Kysely } from 'kysely';
import type { StreamerDB, InsertableVods, SelectableVods } from '../../db/streamer-types';
import type { TenantConfig } from '../../config/types.js';
import type { Platform } from '../../types/platforms.js';
import { getStrategy, type PlatformStreamStatus, type PlatformVodMetadata } from '../../services/platforms/index.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { extractErrorDetails } from '../../utils/error.js';
import { sendStreamOfflineAlert, sendStreamLiveAlert } from './alert-helpers.js';
import { getLiveDownloadQueue, enqueueJobWithLogging } from '../jobs/queues.js';
import type { LiveDownloadJob } from '../jobs/queues.js';
import { getTenantConfig } from '../../config/loader.js';
import { publishVodUpdate } from '../../services/cache-invalidator.js';

type StreamerDbClient = Kysely<StreamerDB>;

export async function handlePlatformLiveCheck(
  db: StreamerDbClient,
  tenantId: string,
  platform: Platform,
  config: TenantConfig,
  activeLiveVod: SelectableVods | null = null
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
    await handleOfflineStream(
      db,
      tenantId,
      platform,
      platformUsername || undefined,
      config.displayName,
      log,
      activeLiveVod
    );
    return;
  }

  await handleLiveStream(
    db,
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
  db: StreamerDbClient,
  tenantId: string,
  platform: Platform,
  username: string | undefined,
  displayName: string | undefined,
  log: ReturnType<typeof createAutoLogger>,
  activeLiveVod: SelectableVods | null = null
): Promise<void> {
  log.debug({ username }, '[Monitor]: Streamer is OFFLINE');

  if (activeLiveVod) {
    log.info({ vodId: activeLiveVod.vod_id }, '[Monitor]: Marking VOD as ended');

    await db.updateTable('vods').set({ is_live: false }).where('id', '=', activeLiveVod.id).execute();

    await publishVodUpdate(tenantId, activeLiveVod.id);

    await sendStreamOfflineAlert(
      platform,
      activeLiveVod.vod_id,
      activeLiveVod.started_at ?? undefined,
      username || undefined,
      displayName
    );
  }
}

async function handleLiveStream(
  db: StreamerDbClient,
  streamStatus: PlatformStreamStatus,
  platform: Platform,
  platformUserId: string,
  platformUsername: string,
  config: TenantConfig,
  strategy: NonNullable<ReturnType<typeof getStrategy>>,
  tenantId: string,
  log: ReturnType<typeof createAutoLogger>
): Promise<void> {
  const existingVod = await db
    .selectFrom('vods')
    .selectAll()
    .where('stream_id', '=', streamStatus.id)
    .where('platform', '=', platform)
    .executeTakeFirst();

  if (!existingVod) {
    await handleNewLiveStream(
      db,
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
      db,
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
  db: StreamerDbClient,
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

  const existingVod = await db
    .selectFrom('vods')
    .selectAll()
    .where('vod_id', '=', vodMetadata.id)
    .where('platform', '=', platform)
    .executeTakeFirst();

  if (existingVod) {
    log.debug({ vodId: vodMetadata.id }, '[Monitor]: VOD was created by concurrent poll');
    return;
  }

  log.info(
    { vodId: vodMetadata.id, startedAt: streamStatus.startedAt },
    '[Monitor]: Creating VOD record for live stream'
  );

  const [createdVod] = await db
    .insertInto('vods')
    .values({
      ...strategy.createVodData(vodMetadata),
      is_live: true,
      started_at: new Date(streamStatus.startedAt),
    } as InsertableVods)
    .returning('id')
    .execute();

  await publishVodUpdate(tenantId, createdVod.id);

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
  db: StreamerDbClient,
  existingVod: { id: number; vod_id: string },
  streamStatus: PlatformStreamStatus,
  platform: Platform,
  platformUserId: string,
  platformUsername: string,
  tenantId: string,
  log: ReturnType<typeof createAutoLogger>
): Promise<void> {
  log.info({ vodId: existingVod.vod_id }, '[Monitor]: Existing VOD is now active');

  await db
    .updateTable('vods')
    .set({
      is_live: true,
      started_at: new Date(streamStatus.startedAt),
    })
    .where('id', '=', existingVod.id)
    .execute();

  await publishVodUpdate(tenantId, existingVod.id);

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
    skipValidation: true,
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
  skipValidation?: boolean;
}): Promise<void> {
  const log = createAutoLogger(params.tenantId);

  if (!params.skipValidation) {
    const validationResult = await validateVodPath(params.tenantId);
    if (!validationResult.valid) {
      log.error(
        { vodId: params.vodId, platform: params.platform },
        `[Monitor] Aborting download queue - VOD path validation failed`
      );
      return;
    }
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
