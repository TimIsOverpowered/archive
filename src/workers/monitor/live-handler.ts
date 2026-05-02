import fs from 'fs/promises';
import path from 'path';
import type { Kysely } from 'kysely';
import type { StreamerDB, InsertableVods, SelectableVods } from '../../db/streamer-types.js';
import type { TenantConfig } from '../../config/types.js';
import { requirePlatformConfig } from '../../config/types.js';
import type { Platform } from '../../types/platforms.js';
import { getStrategy, type PlatformStreamStatus, type PlatformVodMetadata } from '../../services/platforms/index.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { extractErrorDetails } from '../../utils/error.js';
import { sendStreamOfflineAlert, sendStreamLiveAlert } from './alert-helpers.js';
import { getLiveDownloadQueue, LIVE_JOB_ID_PREFIX } from '../queues/queue.js';
import { enqueueJobWithLogging } from '../jobs/enqueue.js';
import type { LiveDownloadJob } from '../jobs/types.js';
import { configService } from '../../config/tenant-config.js';
import { publishVodUpdate } from '../../services/cache-invalidator.js';
import { findVodByStreamId, findVodByPlatformId } from '../../db/queries/vods.js';

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
  activeLiveVod: SelectableVods | null = null
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
      db,
      tenantId,
      platform,
      platformUsername ?? undefined,
      config.displayName,
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

async function handleOfflineStream(
  db: Kysely<StreamerDB>,
  tenantId: string,
  platform: Platform,
  username: string | undefined,
  displayName: string | undefined,
  log: ReturnType<typeof createAutoLogger>,
  activeLiveVod: SelectableVods | null = null
): Promise<void> {
  log.debug({ component: 'monitor', username }, 'Streamer is OFFLINE');

  if (activeLiveVod) {
    log.info({ component: 'monitor', vodId: activeLiveVod.vod_id }, 'Marking VOD as ended');

    await db.updateTable('vods').set({ is_live: false }).where('id', '=', activeLiveVod.id).execute();

    await publishVodUpdate(tenantId, activeLiveVod.id);

    await sendStreamOfflineAlert(
      platform,
      activeLiveVod.vod_id,
      activeLiveVod.started_at ?? undefined,
      username ?? undefined,
      displayName
    );
  }
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
  ctx.log.info({ component: 'monitor', vodId: ctx.existingVod.vod_id }, 'Existing VOD is now active');

  await ctx.db
    .updateTable('vods')
    .set({
      is_live: true,
      started_at: new Date(ctx.streamStatus.startedAt),
    })
    .where('id', '=', ctx.existingVod.id)
    .execute();

  await publishVodUpdate(ctx.tenantId, ctx.existingVod.id);

  ctx.log.info({ vodId: ctx.existingVod.vod_id }, '[Monitor]: Queuing HLS download');

  const vodMetadata = ctx.strategy.fetchVodObjectForLiveStream
    ? await ctx.strategy.fetchVodObjectForLiveStream(ctx.streamStatus.id, {
        tenantId: ctx.tenantId,
        config: ctx.config,
        platform: ctx.platform,
      })
    : null;

  await enqueueLiveHlsDownload({
    dbId: ctx.existingVod.id,
    vodId: ctx.existingVod.vod_id,
    platform: ctx.platform,
    tenantId: ctx.tenantId,
    platformUserId: ctx.platformUserId,
    platformUsername: ctx.platformUsername,
    startedAt: new Date(ctx.streamStatus.startedAt),
    sourceUrl: vodMetadata?.sourceUrl ?? undefined,
  });
}

async function handleAlreadyLiveStream(ctx: AlreadyLiveContext): Promise<void> {
  ctx.log.debug({ component: 'monitor', vodId: ctx.existingVod.vod_id }, 'VOD is live, ensuring download queued');

  const vodMetadata = ctx.strategy.fetchVodObjectForLiveStream
    ? await ctx.strategy.fetchVodObjectForLiveStream(ctx.streamStatus.id, {
        tenantId: ctx.tenantId,
        config: ctx.config,
        platform: ctx.platform,
      })
    : null;

  await enqueueLiveHlsDownload({
    dbId: ctx.existingVod.id,
    vodId: ctx.existingVod.vod_id,
    platform: ctx.platform,
    tenantId: ctx.tenantId,
    platformUserId: ctx.platformUserId,
    platformUsername: ctx.platformUsername,
    startedAt: ctx.existingVod.started_at ?? new Date(ctx.streamStatus.startedAt),
    sourceUrl: vodMetadata?.sourceUrl ?? undefined,
    skipValidation: true,
  });
}

/**
 * Validate that the VOD path exists and is writable before queuing a download job
 */
export async function validateVodPath(tenantId: string): Promise<{ valid: boolean }> {
  const log = createAutoLogger(tenantId);

  try {
    const streamerConfig = configService.get(tenantId);

    if (streamerConfig?.settings.vodPath == null) {
      log.error({ component: 'monitor', tenantId }, 'VOD path not configured for tenant - cannot queue downloads');
      return { valid: false };
    }

    const vodDirBase = streamerConfig.settings.vodPath;

    try {
      await fs.access(vodDirBase, fs.constants.R_OK | fs.constants.W_OK);

      const testSubdir = path.join(vodDirBase, tenantId);
      try {
        await fs.mkdir(testSubdir, { recursive: true });
        log.trace({ component: 'monitor', vodPath: vodDirBase }, 'VOD path validated successfully');
        return { valid: true };
      } catch (mkdirError) {
        const details = extractErrorDetails(mkdirError);
        log.error(
          { component: 'monitor', tenantId, vodPath: testSubdir, error: details.message },
          'Cannot write to VOD path - directory creation failed'
        );
        return { valid: false };
      }
    } catch (accessError) {
      const details = extractErrorDetails(accessError);
      log.error(
        { component: 'monitor', tenantId, vodPath: vodDirBase, error: details.message },
        'VOD path not accessible - check permissions'
      );
      return { valid: false };
    }
  } catch (error) {
    const details = extractErrorDetails(error);
    log.error({ component: 'monitor', tenantId, error: details.message }, 'Unexpected error validating VOD path');
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
  platformUsername?: string | undefined;
  startedAt: Date;
  sourceUrl?: string | undefined;
  skipValidation?: boolean | undefined;
}): Promise<void> {
  const log = createAutoLogger(params.tenantId);

  if (params.skipValidation !== false) {
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
      jobName: `${LIVE_JOB_ID_PREFIX}download`,
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
        jobId: `${LIVE_JOB_ID_PREFIX}${params.vodId}`,
        attempts: 10,
        backoff: { type: 'exponential' as const, delay: 5000 },
        deduplication: { id: `${LIVE_JOB_ID_PREFIX}${params.vodId}` },
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
