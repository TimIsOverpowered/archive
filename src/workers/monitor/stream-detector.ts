import fs from 'fs/promises';
import path from 'path';
import { getTenantConfig } from '../../config/loader.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import {
  QUEUE_NAMES,
  type LiveDownloadJob,
  getLiveDownloadQueue,
  enqueueJobWithLogging,
} from '../../workers/jobs/queues.js';
import { createClient, getClient } from '../../db/client.js';
import type { TenantConfig } from '../../config/types.js';
import { extractErrorDetails } from '../../utils/error.js';
import type { Platform } from '../../types/platforms.js';
import { capitalizePlatform } from '../../types/platforms.js';
import { handlePlatformLiveCheck } from './live-handler.js';

const inFlightChecks = new Map<string, number>();

/**
 * Main polling function - called every 30 seconds per tenant/platform pair
 */
export async function checkPlatformStatus(tenantId: string, platform: Platform, config: TenantConfig): Promise<void> {
  const log = createAutoLogger(tenantId);
  const lockKey = `${tenantId}:${platform}`;

  const startTime = inFlightChecks.get(lockKey);
  if (startTime) {
    const elapsedMs = Date.now() - startTime;
    if (elapsedMs > 60_000) {
      log.warn({ lockKey, elapsedMs }, 'Poll has been in-flight for over 60 seconds, potential deadlock');
    } else {
      log.trace({ lockKey, elapsedMs }, 'Skipping poll, previous check still in flight');
    }
    return;
  }

  inFlightChecks.set(lockKey, Date.now());

  try {
    log.debug({ platform }, '[Monitor]: Polling platform status for streamer...');
    log.debug(
      { vodDownload: config.settings?.vodDownload, platformEnabled: config[platform]?.enabled },
      '[Monitor]: Config values'
    );

    const prisma = getClient(tenantId) || (await createClient(config));

    if (config.settings.vodDownload && config[platform]?.enabled) {
      log.debug(
        { platform, vodDownload: config.settings.vodDownload },
        `[${capitalizePlatform(platform)}]: Monitoring enabled`
      );
      await handlePlatformLiveCheck(prisma, tenantId, platform, config);
    } else {
      const reasons = [];

      if (!config[platform]?.enabled) {
        reasons.push(`${capitalizePlatform(platform)} not enabled`);
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
      log.error(
        { platform, ...details },
        `[${capitalizePlatform(platform)}] Error in stream status check (no response)`
      );
    } else {
      log.error({ platform, ...details }, `[${capitalizePlatform(platform)}] Error in stream status check`);
    }
  } finally {
    inFlightChecks.delete(lockKey);
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
export function startStreamDetectionLoop(tenantId: string, platform: Platform, config: TenantConfig): void {
  const log = createAutoLogger(tenantId);
  log.info(`[${capitalizePlatform(platform)}]: Starting stream detection polling every 30 seconds`);

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
      const details = extractErrorDetails(error);
      log.error({ err: details.message }, `[${capitalizePlatform(platform)}] Error in polling cycle`);
    }
  }, 30_000);

  const key = `${tenantId}:${platform}`;

  const globalObj = global as NodeJS.Global;
  if (!globalObj.monitorIntervals) {
    globalObj.monitorIntervals = new Map();
  }
  globalObj.monitorIntervals.set(key, intervalId);

  log.info({ timeout: 30000 }, `[${capitalizePlatform(platform)}]: Polling loop started`);
}
