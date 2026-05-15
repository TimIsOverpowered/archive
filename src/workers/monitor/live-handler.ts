import fs from 'node:fs/promises';
import type { Kysely } from 'kysely';
import { getTmpPath } from '../../config/env.js';
import type { TenantConfig } from '../../config/types.js';
import { requirePlatformConfig } from '../../config/types.js';
import { Jobs } from '../../constants.js';
import type { ActiveLiveVodResult } from '../../db/queries/vods.js';
import { findVodByStreamId, findVodByPlatformId } from '../../db/queries/vods.js';
import type { StreamerDB, InsertableVods, SelectableVods } from '../../db/streamer-types.js';
import { publishVodUpdate } from '../../services/cache-invalidator.js';
import { getStrategy, type PlatformStreamStatus, type PlatformVodMetadata } from '../../services/platforms/index.js';
import type { TwitchStreamStatus } from '../../services/twitch/live.js';
import { PLATFORMS, type Platform } from '../../types/platforms.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { extractErrorDetails } from '../../utils/error.js';
import { enqueueJobWithLogging } from '../jobs/enqueue.js';
import type { LiveDownloadJob } from '../jobs/types.js';
import { getLiveDownloadQueue } from '../queues/queue.js';
import { sendStreamLiveAlert } from './alert-helpers.js';

interface LiveStreamContext {
  db: Kysely<StreamerDB>;
  streamStatus: PlatformStreamStatus;
  platform: Platform;
  platformUserId: string;
  platformUsername: string;
  config: TenantConfig;
  strategy: NonNullable<ReturnType<typeof getStrategy>>;
  tenantId: string;
  log: ReturnType<typeof createAutoLogger>;
}

// ExistingVodLiveContext: stream came back online on an existing VOD that was marked is_live=false.
type ExistingVodLiveContext = LiveStreamContext & { existingVod: SelectableVods };

// AlreadyLiveContext: stream is currently live on an existing VOD.
type AlreadyLiveContext = LiveStreamContext & { existingVod: SelectableVods };

export async function handlePlatformLiveCheck(
  db: Kysely<StreamerDB>,
  tenantId: string,
  platform: Platform,
  config: TenantConfig,
  activeLiveVod: ActiveLiveVodResult | null = null
): Promise<void> {
  const log = createAutoLogger(tenantId);

  const strategy = getStrategy(platform);
  if (!strategy) {
    log.warn({ component: 'monitor', platform }, 'No strategy found for platform');
    return;
  }

  const platformInfo = requirePlatformConfig(config, platform);
  if (!platformInfo) {
    log.debug({ component: 'monitor', platform }, 'Platform not fully configured');
    return;
  }
  const { platformUserId, platformUsername } = platformInfo;

  let streamStatus: PlatformStreamStatus | null;

  try {
    const ctx = { tenantId, config, platform } as const;
    streamStatus = await strategy.checkStreamStatus(ctx);
  } catch (error: unknown) {
    const details = extractErrorDetails(error);
    log.warn(
      { component: 'monitor', userId: platformUserId, platform, err: details.message },
      'API error - skipping check'
    );
    return;
  }

  if (!streamStatus) {
    await handleOfflineStream(
      tenantId,
      platform,
      config,
      strategy,
      platformUserId,
      platformUsername ?? undefined,
      log,
      activeLiveVod
    );
    return;
  }

  await handleLiveStream({
    db,
    streamStatus,
    platform,
    platformUserId,
    platformUsername,
    config,
    strategy: strategy,
    tenantId,
    log,
  });
}

/**
 * Handle a live check for a tenant using a pre-fetched Twitch stream status.
 * Used by the batch monitor job to avoid redundant API calls.
 */
export async function handlePlatformLiveCheckWithStreamStatus(
  db: Kysely<StreamerDB>,
  tenantId: string,
  config: TenantConfig,
  twitchStatus: TwitchStreamStatus | null,
  activeLiveVod: ActiveLiveVodResult | null = null
): Promise<void> {
  const log = createAutoLogger(tenantId);
  const platform = 'twitch' as Platform;

  const strategy = getStrategy(platform);
  if (!strategy) {
    log.warn({ component: 'monitor', platform }, 'No strategy found for platform');
    return;
  }

  const platformInfo = requirePlatformConfig(config, platform);
  if (!platformInfo) {
    log.debug({ component: 'monitor', platform }, 'Platform not fully configured');
    return;
  }
  const { platformUserId, platformUsername } = platformInfo;

  if (!twitchStatus || twitchStatus.type !== 'live') {
    await handleOfflineStream(
      tenantId,
      platform,
      config,
      strategy,
      platformUserId,
      platformUsername ?? undefined,
      log,
      activeLiveVod
    );
    return;
  }

  const streamStatus: PlatformStreamStatus = {
    id: twitchStatus.id,
    title: twitchStatus.title,
    startedAt: twitchStatus.started_at,
    streamId: twitchStatus.id,
    platformUserId: twitchStatus.user_id,
    platformUsername: twitchStatus.user_login,
  };

  await handleLiveStream({
    db,
    streamStatus,
    platform,
    platformUserId,
    platformUsername,
    config,
    strategy,
    tenantId,
    log,
  });
}

async function handleOfflineStream(
  tenantId: string,
  platform: Platform,
  config: TenantConfig,
  strategy: NonNullable<ReturnType<typeof getStrategy>>,
  platformUserId: string,
  platformUsername: string | undefined,
  log: ReturnType<typeof createAutoLogger>,
  activeLiveVod: ActiveLiveVodResult | null = null
): Promise<void> {
  log.debug({ component: 'monitor', platform }, 'Streamer is OFFLINE');

  if (!activeLiveVod || activeLiveVod.platform_vod_id == null || activeLiveVod.platform_vod_id === '') return;

  const liveQueue = getLiveDownloadQueue();
  const jobId = `${Jobs.LIVE_HLS_JOB_PREFIX}${activeLiveVod.platform_vod_id}`;
  const queuedJob = await liveQueue.getJob(jobId);

  if (queuedJob !== undefined) {
    const [isActive, isWaiting, isDelayed] = await Promise.all([
      queuedJob.isActive(),
      queuedJob.isWaiting(),
      queuedJob.isDelayed(),
    ]);
    if (isActive || isWaiting || isDelayed) {
      log.debug(
        { component: 'monitor', vodId: activeLiveVod.platform_vod_id },
        'Skipping - live worker job still in queue'
      );
      return;
    }
  }

  let sourceUrl: string | undefined;
  if (platform === PLATFORMS.KICK) {
    try {
      const vodMetadata = await strategy.fetchVodMetadata(activeLiveVod.platform_vod_id, {
        tenantId,
        config,
        platform,
      });
      sourceUrl = vodMetadata?.sourceUrl ?? undefined;
    } catch (error) {
      log.warn(
        { vodId: activeLiveVod.platform_vod_id, err: extractErrorDetails(error).message },
        'Failed to fetch Kick VOD metadata for re-queue'
      );
    }
  }

  log.info(
    { component: 'monitor', vodId: activeLiveVod.platform_vod_id },
    'No active job found — re-queuing live download for recovery'
  );

  await enqueueLiveHlsDownload({
    dbId: activeLiveVod.id,
    vodId: activeLiveVod.platform_vod_id,
    platform,
    tenantId,
    platformUserId,
    platformUsername,
    startedAt: activeLiveVod.started_at ?? new Date(),
    sourceUrl,
  });
}

async function handleLiveStream(ctx: LiveStreamContext): Promise<void> {
  const existingVod = await findVodByStreamId(ctx.db, ctx.streamStatus.id, ctx.platform);

  if (!existingVod) {
    await handleNewLiveStream(ctx);
    return;
  }

  if (!existingVod.is_live) {
    await handleExistingVodBecameLive({ ...ctx, existingVod });
    return;
  }

  await handleAlreadyLiveStream({ ...ctx, existingVod });
}

async function handleNewLiveStream(ctx: LiveStreamContext): Promise<void> {
  ctx.log.info({ component: 'monitor', streamId: ctx.streamStatus.id }, 'New live detected, checking for VOD object');

  const metadataCtx = { tenantId: ctx.tenantId, config: ctx.config, platform: ctx.platform };
  let vodMetadata: PlatformVodMetadata | null = null;

  if (ctx.strategy.fetchVodObjectForLiveStream) {
    vodMetadata = await ctx.strategy.fetchVodObjectForLiveStream(ctx.streamStatus.id, metadataCtx);
  }

  if (!vodMetadata) {
    if (ctx.config.settings.vodDownload === false) {
      ctx.log.info(
        { component: 'monitor', streamId: ctx.streamStatus.id },
        'VODs disabled - creating VOD record without platform VOD ID'
      );

      const [createdVod] = await ctx.db
        .insertInto('vods')
        .values({
          platform: ctx.platform,
          title: null,
          created_at: new Date().toISOString(),
          duration: 0,
          platform_stream_id: ctx.streamStatus.id,
          is_live: true,
          started_at: new Date(ctx.streamStatus.startedAt),
        } as InsertableVods)
        .returning('id')
        .execute();

      if (!createdVod) {
        ctx.log.error({ component: 'monitor' }, 'Failed to create VOD record');
        return;
      }

      await publishVodUpdate(ctx.tenantId, createdVod.id);
      return;
    }

    ctx.log.debug({ component: 'monitor' }, 'No VOD object found yet');
    return;
  }

  const existingVod = await findVodByPlatformId(ctx.db, vodMetadata.id, ctx.platform);

  if (existingVod) {
    ctx.log.debug({ component: 'monitor', vodId: vodMetadata.id }, 'VOD was created by concurrent poll');
    return;
  }

  ctx.log.info(
    { component: 'monitor', vodId: vodMetadata.id, startedAt: ctx.streamStatus.startedAt },
    'Creating VOD record for live stream'
  );

  const [createdVod] = await ctx.db
    .insertInto('vods')
    .values({
      ...ctx.strategy.createVodData(vodMetadata),
      is_live: true,
      started_at: new Date(ctx.streamStatus.startedAt),
    } as InsertableVods)
    .returning('id')
    .execute();

  if (!createdVod) {
    ctx.log.error({ component: 'monitor', vodId: vodMetadata.id }, 'Failed to create VOD record');
    return;
  }

  await publishVodUpdate(ctx.tenantId, createdVod.id);

  await sendStreamLiveAlert(
    ctx.platform,
    vodMetadata.id,
    ctx.streamStatus.title,
    ctx.platformUsername,
    ctx.config.displayName
  );

  ctx.log.info({ component: 'monitor', vodId: vodMetadata.id }, 'Queuing HLS download');

  await enqueueLiveHlsDownload({
    dbId: createdVod.id,
    vodId: vodMetadata.id,
    platform: ctx.platform,
    tenantId: ctx.tenantId,
    platformUserId: ctx.platformUserId,
    platformUsername: ctx.platformUsername,
    startedAt: new Date(ctx.streamStatus.startedAt),
    sourceUrl: vodMetadata.sourceUrl ?? undefined,
  });
}

async function handleExistingVodBecameLive(ctx: ExistingVodLiveContext): Promise<void> {
  ctx.log.info(
    { component: 'monitor', vodId: ctx.existingVod.platform_vod_id, streamId: ctx.existingVod.platform_stream_id },
    'Existing VOD is now active'
  );

  await ctx.db
    .updateTable('vods')
    .set({
      is_live: true,
      started_at: new Date(ctx.streamStatus.startedAt),
    })
    .where('id', '=', ctx.existingVod.id)
    .execute();

  await publishVodUpdate(ctx.tenantId, ctx.existingVod.id);

  const vodMetadata = ctx.strategy.fetchVodObjectForLiveStream
    ? await ctx.strategy.fetchVodObjectForLiveStream(ctx.streamStatus.id, {
        tenantId: ctx.tenantId,
        config: ctx.config,
        platform: ctx.platform,
      })
    : null;

  if (!vodMetadata) {
    ctx.log.warn(
      { component: 'monitor', dbId: ctx.existingVod.id },
      'Failed to fetch VOD metadata - skipping HLS download'
    );
    return;
  }

  ctx.log.info({ vodId: vodMetadata.id }, '[Monitor]: Queuing HLS download');

  await enqueueLiveHlsDownload({
    dbId: ctx.existingVod.id,
    vodId: vodMetadata.id,
    platform: ctx.platform,
    tenantId: ctx.tenantId,
    platformUserId: ctx.platformUserId,
    platformUsername: ctx.platformUsername,
    startedAt: new Date(ctx.streamStatus.startedAt),
    sourceUrl: vodMetadata.sourceUrl ?? undefined,
  });
}

async function handleAlreadyLiveStream(ctx: AlreadyLiveContext): Promise<void> {
  ctx.log.debug(
    { component: 'monitor', vodId: ctx.existingVod.platform_vod_id },
    'VOD is live, ensuring download queued'
  );

  const vodMetadata = ctx.strategy.fetchVodObjectForLiveStream
    ? await ctx.strategy.fetchVodObjectForLiveStream(ctx.streamStatus.id, {
        tenantId: ctx.tenantId,
        config: ctx.config,
        platform: ctx.platform,
      })
    : null;

  if (!vodMetadata) {
    ctx.log.warn(
      { component: 'monitor', dbId: ctx.existingVod.id },
      'Failed to fetch VOD metadata - skipping HLS download'
    );
    return;
  }

  await enqueueLiveHlsDownload({
    dbId: ctx.existingVod.id,
    vodId: vodMetadata.id,
    platform: ctx.platform,
    tenantId: ctx.tenantId,
    platformUserId: ctx.platformUserId,
    platformUsername: ctx.platformUsername,
    startedAt: ctx.existingVod.started_at ?? new Date(ctx.streamStatus.startedAt),
    sourceUrl: vodMetadata.sourceUrl ?? undefined,
    skipValidation: true,
  });
}

/**
 * Validate that the VOD path exists and is writable before queuing a download job
 */
async function validateVodPath(_tenantId: string): Promise<{ valid: boolean }> {
  const tmpPath = getTmpPath();

  if (tmpPath == null) {
    return { valid: true };
  }

  try {
    await fs.access(tmpPath, fs.constants.R_OK | fs.constants.W_OK);
    return { valid: true };
  } catch {
    return { valid: false };
  }
}

/**
 * Enqueue Live HLS Download job
 */
async function enqueueLiveHlsDownload(params: {
  dbId: number;
  vodId: string;
  platform: Platform;
  tenantId: string;
  platformUserId: string;
  platformUsername?: string | undefined;
  startedAt: Date;
  sourceUrl?: string | undefined;
  skipValidation?: boolean | undefined;
}): Promise<void> {
  const log = createAutoLogger(params.tenantId);

  if (params.skipValidation !== true) {
    const validationResult = await validateVodPath(params.tenantId);
    if (!validationResult.valid) {
      log.error(
        { component: 'monitor', vodId: params.vodId, platform: params.platform },
        'Aborting download queue - VOD path validation failed'
      );
      return;
    }
  }

  const queue = getLiveDownloadQueue();

  try {
    log.debug(
      { component: 'monitor', vodId: params.vodId, platform: params.platform, tenantId: params.tenantId },
      'Attempting to enqueue Live HLS download job'
    );

    const { jobId, isNew } = await enqueueJobWithLogging({
      queue,
      jobName: `${Jobs.LIVE_HLS_JOB_PREFIX}download`,
      data: {
        dbId: params.dbId,
        vodId: params.vodId,
        platform: params.platform,
        tenantId: params.tenantId,
        platformUserId: params.platformUserId,
        platformUsername: params.platformUsername,
        startedAt: params.startedAt.toISOString(),
        sourceUrl: params.sourceUrl,
      } satisfies LiveDownloadJob,
      options: {
        jobId: `${Jobs.LIVE_HLS_JOB_PREFIX}${params.vodId}`,
        attempts: 10,
        backoff: { type: 'exponential' as const, delay: 5000 },
        deduplication: { id: `${Jobs.LIVE_HLS_JOB_PREFIX}${params.vodId}` },
        removeOnComplete: true,
        removeOnFail: true,
      },
      logger: { info: log.info.bind(log), debug: log.debug.bind(log) },
      successMessage: 'Live HLS download job enqueued successfully',
      extraContext: { dbId: params.dbId, vodId: params.vodId, platform: params.platform, queueName: 'vod_live' },
    });

    if (isNew) {
      log.debug({ component: 'monitor', vodId: params.vodId, jobId }, 'Job was newly added to queue');
    }
  } catch (error) {
    const details = extractErrorDetails(error);
    log.error(
      { component: 'monitor', vodId: params.vodId, ...details },
      'CRITICAL - Failed to enqueue Live HLS download job'
    );
  }
}
