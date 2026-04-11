import fsPromises from 'fs/promises';
import { extractErrorDetails } from '../../utils/error.js';
import fs from 'fs';
import pathMod from 'path';
import HLS from 'hls-parser';
import { getTenantConfig } from '../../config/loader';
import { getClient } from '../../db/client';
import { sendRichAlert, updateDiscordEmbed, isAlertsEnabled } from '../../utils/discord-alerts.js';
import { createAutoLogger as loggerWithTenant } from '../../utils/auto-tenant-logger.js';
import { createSession, type CycleTLSSession } from '../../utils/cycletls.js';
import { updateChapterDuringDownload } from '../../services/kick.js';
import { downloadSegmentsParallel, fetchTwitchPlaylist, fetchKickPlaylist, type DownloadStrategy } from './hls-utils.js';
import { sleep, getRetryDelay } from '../../utils/delay.js';
import { toHHMMSS } from '../../utils/formatting.js';

export interface HlsDownloadOptions {
  dbId: number;
  vodId: string;
  platform: 'twitch' | 'kick';
  tenantId: string;
  platformUserId: string;
  platformUsername?: string;
  startedAt?: string;
  sourceUrl?: string;
}

export interface HlsDownloadResult {
  success: true;
  m3u8Path: string;
  outputDir: string;
  segmentCount: number;
}

function updateAlertProgress(messageId: string | null, platform: string, totalSegmentsFound: number, vodId: string, tenantId: string, startedAt?: string): void {
  if (!messageId || !isAlertsEnabled()) return;

  const streamerName = getTenantConfig(tenantId)?.displayName || tenantId;

  // Calculate elapsed time
  const startTime = startedAt ? new Date(startedAt) : new Date();
  const elapsedSeconds = Math.floor((Date.now() - startTime.getTime()) / 1000);

  const fields = [
    { name: 'Platform', value: platform, inline: true },
    { name: 'Segments', value: String(totalSegmentsFound), inline: true },
    { name: 'Elapsed Time', value: toHHMMSS(elapsedSeconds), inline: false },
  ];

  updateDiscordEmbed(messageId, {
    title: `📥 Downloading ${vodId} (LIVE)`,
    description: `${streamerName} - ${platform.toUpperCase()} live HLS download in progress`,
    status: 'warning',
    fields,
    timestamp: startTime.toISOString(),
    updatedTimestamp: new Date().toISOString(),
  });
}

export async function downloadLiveHls(options: HlsDownloadOptions, signal?: AbortSignal): Promise<HlsDownloadResult> {
  const { dbId, vodId, platform, tenantId, platformUserId, platformUsername, startedAt, sourceUrl } = options;

  const log = loggerWithTenant(tenantId);

  log.info(
    {
      dbId,
      vodId,
      platform,
      tenantId,
      platformUserId,
      platformUsername,
      startedAt,
      hasSourceUrl: !!sourceUrl,
    },
    `[HLS-Downloader] Starting Live HLS Download mode for ${platform} stream`
  );
  const streamerClient = getClient(tenantId);
  try {
    if (!streamerClient) throw new Error('Streamer database client not available');

    const vodRecord = await streamerClient.vod.findUnique({ where: { id: dbId } });

    if (!vodRecord || !vodRecord.id) throw new Error(`VOD record not found for ${vodId}`);
  } catch (error: unknown) {
    const details = extractErrorDetails(error);
    log.error({ ...details, vodId }, `[${vodId}] Failed to get database connection`);
    throw error;
  }

  const config = getTenantConfig(tenantId);

  if (!config) {
    log.error({ vodId, tenantId, platform }, `[HLS-Downloader] CRITICAL - Stream config not found. Cannot proceed with download.`);
    throw new Error(`Stream config not found for VOD ${vodId} (tenantId: ${tenantId})`);
  }

  log.debug({ vodId, tenantId, vodPath: config.settings.vodPath }, `[HLS-Downloader] Configuration loaded successfully`);

  // Initialize alert state
  let messageId: string | null = null;

  if (isAlertsEnabled()) {
    try {
      const startTime = new Date().toISOString();

      messageId = await sendRichAlert({
        title: `[HLS] Live Stream Started: ${vodId}`,
        description: `${platform.toUpperCase()} live HLS download in progress`,
        status: 'warning',
        fields: [
          { name: 'Platform', value: platform, inline: true },
          { name: 'Tenant ID', value: tenantId, inline: true },
          { name: 'Started At', value: startedAt || startTime, inline: false },
        ],
        timestamp: startTime,
      });
    } catch (error) {
      const details = extractErrorDetails(error);
      log.warn(`Failed to initialize Discord alert: ${details.message}`);
    }
  }

  const { getVodDirPath } = await import('../../utils/path.js');

  const vodDir = getVodDirPath({ tenantId, vodId: String(vodId) });

  try {
    await fsPromises.mkdir(vodDir, { recursive: true });
    log.debug(`[${vodId}] Created download directory: ${vodDir}`);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new Error(`Failed to create VOD directory ${vodDir}: ${(error as Error).message}`);
    }
  }

  const m3u8Path = pathMod.join(vodDir, `${vodId}.m3u8`);

  let retryCount = 0;
  const maxRetryBeforeEndDetection = 12;
  let lastSegmentUri: string | null = null;
  let noChangePollCounter = 0;
  let baseURL: string = '';

  // Create persistent CycleTLS session for Kick downloads
  let cycleTLS: CycleTLSSession | null = null;

  if (platform === 'kick') {
    cycleTLS = createSession();
    log.info(`[${vodId}] Created CycleTLS session for Kick HLS download`);
  }

  log.debug(`[${vodId}] Starting HLS polling loop...`);

  while (true) {
    try {
      log.trace({ vodId, retryCount: retryCount + 1 }, `Polling HLS playlist (attempt #${retryCount + 1})...`);

      let variantM3u8String: string = '';
      let fetchedBaseURL: string = '';

      if (platform === 'twitch') {
        const result = await fetchTwitchPlaylist(vodId, log, retryCount, maxRetryBeforeEndDetection);

        if (!result) {
          retryCount++;
          await sleep(getRetryDelay(retryCount));
          continue;
        }

        variantM3u8String = result.variantM3u8String;
        fetchedBaseURL = result.baseURL;
      } else if (platform === 'kick') {
        const result = await fetchKickPlaylist(vodId, sourceUrl, log, retryCount, maxRetryBeforeEndDetection, cycleTLS ?? undefined);

        if (!result) {
          retryCount++;
          await sleep(getRetryDelay(retryCount));
          continue;
        }

        variantM3u8String = result.variantM3u8String;
        fetchedBaseURL = result.baseURL;
      }

      const parsedM3u8: HLS.types.MasterPlaylist | HLS.types.MediaPlaylist = HLS.parse(variantM3u8String);

      if (!parsedM3u8) {
        log.error(`[${vodId}] Invalid HLS playlist structure`);

        retryCount++;
        await sleep(60000);
        continue;
      }

      baseURL = fetchedBaseURL;
      const segments: HLS.types.Segment[] = (parsedM3u8 as HLS.types.MediaPlaylist).segments || [];
      const currentLastSegment = segments?.[segments.length - 1]?.uri || '';

      if (lastSegmentUri === currentLastSegment && lastSegmentUri !== null) {
        noChangePollCounter++;

        log.info(`[${vodId}] No new segments detected. Poll #${noChangePollCounter} without change.`);

        const maxNoChangeThreshold = 5; // 5 polls * 60s = ~300 seconds (5 minutes) for stream end detection

        if (noChangePollCounter >= maxNoChangeThreshold) {
          log.info(`[${vodId}] Stream end detected after ${noChangePollCounter} unchanged polls (${noChangePollCounter * 60}s)`);

          break; // Exit polling loop - assume stream has ended naturally or platform stopped sending updates
        }
      } else {
        if (noChangePollCounter > 0) {
          log.info(`[${vodId}] New segment detected. Resuming download after ${noChangePollCounter} idle polls.`);
        }

        lastSegmentUri = currentLastSegment;
        noChangePollCounter = 0;
      }

      await fsPromises.writeFile(m3u8Path, variantM3u8String);

      log.debug(`[${vodId}] Playlist written. Total segments so far: ${segments.length}`);

      const newSegments = segments.filter((seg) => !fs.existsSync(pathMod.join(vodDir, seg.uri)));

      if (newSegments.length > 0) {
        log.debug(`[${vodId}] Found ${newSegments.length} new segments to download...`);

        const concurrency = 3;
        const retryAttempts = 3;

        try {
          const strategy: DownloadStrategy = platform === 'kick' && cycleTLS ? { type: 'cycletls', session: cycleTLS } : { type: 'fetch', signal };

          await downloadSegmentsParallel(newSegments, vodDir, baseURL, strategy, concurrency, retryAttempts, log, () => {
            if (isAlertsEnabled() && messageId) {
              updateAlertProgress(messageId, platform, segments.length, vodId, tenantId, startedAt);
            }
          });
        } catch (error: unknown) {
          const details = extractErrorDetails(error);

          if (details.message === 'Download aborted') {
            log.info({ vodId }, `[${vodId}] Download aborted`);
            throw error;
          }

          log.error({ ...details, vodId }, `[${vodId}] Error downloading segments`);

          retryCount++;

          if (retryCount > maxRetryBeforeEndDetection) {
            throw new Error('Segment download failed after multiple retries');
          }

          await sleep(getRetryDelay(retryCount));

          continue;
        }
      } else {
        log.debug(`[${vodId}] No new segments. Last segment: ${currentLastSegment}`);
      }

      retryCount = 0;

      if (platform === 'kick' && streamerClient) {
        await updateChapterDuringDownload(dbId, vodId, tenantId, streamerClient);
      }

      await sleep(60000); // Poll every 60 seconds for VOD downloads
    } catch (error: unknown) {
      const details = extractErrorDetails(error);
      log.error({ ...details, vodId }, `[${vodId}] Error in HLS poll cycle`);

      retryCount++;

      await sleep(getRetryDelay(retryCount));

      if (retryCount > maxRetryBeforeEndDetection) {
        // Higher threshold for complete failures vs just no segments
        log.error(`[${vodId}] Aborting live HLS download after ${retryCount} consecutive errors`);

        throw new Error('Live HLS polling failed repeatedly');
      }

      continue;
    }
  }

  const filesInDir = await fsPromises.readdir(vodDir);
  const mp4Segments = filesInDir.filter((f) => f.endsWith('.mp4'));
  const tsSegments = filesInDir.filter((f) => f.endsWith('.ts'));
  const finalSegmentCount = mp4Segments.length || tsSegments.length;

  // Close CycleTLS session for Kick downloads
  if (cycleTLS) {
    await cycleTLS.close();
    log.info(`[${vodId}] Closed CycleTLS session`);
  }

  log.info({ vodId, platform, totalSegmentsDownloaded: finalSegmentCount }, `[HLS-Downloader] Stream download complete`);

  return {
    success: true,
    m3u8Path,
    outputDir: vodDir,
    segmentCount: finalSegmentCount,
  };
}

export default downloadLiveHls;
