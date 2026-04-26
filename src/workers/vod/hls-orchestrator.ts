import fsPromises from 'fs/promises';
import pathMod from 'path';
import HLS from 'hls-parser';
import { extractErrorDetails } from '../../utils/error.js';
import { DownloadAbortedError } from '../../utils/domain-errors.js';
import { getVodDirPath, getVodFilePath } from '../../utils/path.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import type { AppLogger } from '../../utils/logger.js';
import { createSession, type CycleTLSSession } from '../../utils/cycletls.js';
import { updateChapterDuringDownload } from '../../services/kick/index.js';
import {
  downloadSegmentsParallel,
  fetchTwitchPlaylist,
  fetchKickPlaylist,
  type DownloadStrategy,
} from './hls-utils.js';
import { sleep, getRetryDelay } from '../../utils/delay.js';
import { convertHlsToMp4, detectFmp4FromPlaylist } from '../utils/ffmpeg.js';
import { createVodWorkerAlerts } from '../utils/alert-factories.js';
import { updateAlert } from '../../utils/discord-alerts.js';
import { cleanupHlsFiles } from './hls-cleanup.js';
import {
  HLS_MAX_CONSECUTIVE_ERRORS,
  HLS_NO_CHANGE_THRESHOLD,
  HLS_POLL_INTERVAL_MS,
  HLS_SEGMENT_CONCURRENCY,
  HLS_SEGMENT_RETRY_ATTEMPTS,
} from '../../constants.js';
import { PLATFORMS, type Platform } from '../../types/platforms.js';
import { TenantContext } from '../../types/context.js';
import type { TenantConfig } from '../../config/types.js';
import { updateVodDurationDuringDownload } from './duration-updater.js';

export interface HlsDownloadOptions {
  ctx: TenantContext;
  dbId: number;
  vodId: string;
  platform: Platform;
  platformUserId: string;
  platformUsername?: string | undefined;
  startedAt?: string | undefined;
  sourceUrl?: string | undefined;
  isLive?: boolean | undefined;
  discordMessageId?: string | null | undefined;
  streamerName?: string | undefined;
  onProgress?: ((segmentsDownloaded: number) => void) | undefined;
}

export interface HlsDownloadResult {
  success: true;
  m3u8Path: string;
  outputDir: string;
  segmentCount: number;
  finalMp4Path: string;
}

interface HlsConvertOptions {
  vodId: string;
  tenantId: string;
  config: TenantConfig;
  onConversionProgress?: (percent: number) => void;
  discordMessageId?: string | null;
}

interface HlsSegmentFilterResult {
  newSegments: HLS.types.Segment[];
  isStreamEnd: boolean;
  newLastSegmentUri: string;
  newNoChangeCount: number;
}

export async function downloadHlsStream(options: HlsDownloadOptions): Promise<HlsDownloadResult> {
  const { ctx, dbId, vodId, platform, startedAt, sourceUrl, isLive = false, onProgress } = options;
  const { config, tenantId } = ctx;
  const log = createAutoLogger(tenantId);

  const vodDir = getVodDirPath({ config, vodId });
  const finalMp4Path = getVodFilePath({ config, vodId });
  await fsPromises.mkdir(vodDir, { recursive: true });

  const m3u8Path = pathMod.join(vodDir, `${vodId}.m3u8`);

  const cycleTLS = platform === PLATFORMS.KICK ? createSession() : null;
  if (cycleTLS) log.info({ vodId }, 'CycleTLS session created');

  try {
    if (isLive) {
      await runLivePollingLoop(
        {
          ctx,
          vodId,
          platform,
          dbId,
          sourceUrl,
          startedAt,
          vodDir,
          m3u8Path,
          cycleTLS,
          log,
          concurrency: HLS_SEGMENT_CONCURRENCY,
        },
        onProgress
      );
    } else {
      await downloadArchivedVod({
        ctx,
        vodId,
        platform,
        sourceUrl,
        vodDir,
        m3u8Path,
        cycleTLS,
        log,
      });
    }

    const result = await convertAndCleanup(
      m3u8Path,
      finalMp4Path,
      vodDir,
      {
        vodId,
        tenantId,
        config,
        onConversionProgress: (percent) => {
          if (options.discordMessageId != null) {
            void updateAlert(
              options.discordMessageId,
              createVodWorkerAlerts().progress(vodId, `Converting ${vodId} (${percent}%)`)
            );
          }
        },
        discordMessageId: options.discordMessageId ?? null,
      },
      log
    );

    log.info({ vodId, platform, segmentCount: result.segmentCount }, 'HLS download and conversion complete');

    return {
      success: true,
      m3u8Path,
      outputDir: vodDir,
      segmentCount: result.segmentCount,
      finalMp4Path: result.finalMp4Path,
    };
  } finally {
    if (cycleTLS) {
      cycleTLS.close();
      log.info({ vodId }, 'CycleTLS session closed');
    }
  }
}

async function convertAndCleanup(
  m3u8Path: string,
  finalMp4Path: string,
  vodDir: string,
  options: HlsConvertOptions,
  log: AppLogger
): Promise<{ segmentCount: number; finalMp4Path: string }> {
  const { vodId, config } = options;

  const m3u8Content = await fsPromises.readFile(m3u8Path, 'utf8');
  const isFmp4 = detectFmp4FromPlaylist(m3u8Content);

  log.info({ vodId, isFmp4 }, 'Converting HLS to MP4');
  await convertHlsToMp4(m3u8Path, finalMp4Path, {
    vodId,
    isFmp4,
    ...(options.onConversionProgress && { onProgress: options.onConversionProgress }),
  });

  const files = await fsPromises.readdir(vodDir);
  const segmentCount = files.filter((f) => f.endsWith('.mp4') || f.endsWith('.ts')).length;

  const shouldKeepHls = config.settings.saveHLS ?? false;
  if (shouldKeepHls) {
    log.info({ vodId }, 'Preserving HLS files (saveHLS=true)');
  } else {
    log.info({ vodId }, 'Cleaning up HLS files');
  }
  await cleanupHlsFiles(vodDir, shouldKeepHls, log);

  return { segmentCount, finalMp4Path };
}

function filterNewSegments(
  segments: HLS.types.Segment[],
  downloadedSegments: Set<string>,
  lastSegmentUri: string | null,
  noChangeCount: number
): HlsSegmentFilterResult {
  const currentLastUri = segments.at(-1)?.uri ?? '';

  if (currentLastUri != null && currentLastUri !== '' && currentLastUri === lastSegmentUri) {
    noChangeCount++;
  } else {
    lastSegmentUri = currentLastUri;
    noChangeCount = 0;
  }

  const isStreamEnd = noChangeCount >= HLS_NO_CHANGE_THRESHOLD;

  const newSegments = segments.filter((seg) => !downloadedSegments.has(seg.uri));

  return { newSegments, isStreamEnd, newLastSegmentUri: currentLastUri, newNoChangeCount: noChangeCount };
}

interface LivePollingContext {
  ctx: TenantContext;
  vodId: string;
  platform: Platform;
  dbId: number;
  sourceUrl?: string | undefined;
  startedAt?: string | undefined;
  vodDir: string;
  m3u8Path: string;
  cycleTLS: CycleTLSSession | null;
  log: AppLogger;
  concurrency: number;
}

async function runLivePollingLoop(
  ctx: LivePollingContext,
  onProgress?: (segmentsDownloaded: number) => void
): Promise<void> {
  const { vodId, platform, log, concurrency } = ctx;

  let consecutiveErrors = 0;
  let noChangePollCount = 0;
  let lastSegmentUri: string | null = null;

  const downloadedSegments = new Set<string>(await fsPromises.readdir(ctx.vodDir));

  while (true) {
    try {
      const playlist = await fetchPlaylist(ctx, consecutiveErrors);

      if (!playlist) {
        consecutiveErrors++;
        await sleep(getRetryDelay(consecutiveErrors));
        continue;
      }

      const { variantM3u8String, baseURL } = playlist;
      const parsed = HLS.parse(variantM3u8String) as HLS.types.MediaPlaylist;
      const segments = parsed.segments ?? [];

      await fsPromises.writeFile(ctx.m3u8Path, variantM3u8String);

      const result = filterNewSegments(segments, downloadedSegments, lastSegmentUri, noChangePollCount);

      if (result.isStreamEnd) {
        log.info({ vodId }, 'Stream end detected');
        break;
      }

      if (noChangePollCount > 0 && result.newNoChangeCount === 0) {
        log.info({ vodId, resumedAfter: noChangePollCount }, 'New segments resumed');
      }

      lastSegmentUri = result.newLastSegmentUri;
      noChangePollCount = result.newNoChangeCount;

      if (result.newSegments.length > 0) {
        const strategy: DownloadStrategy =
          platform === PLATFORMS.KICK && ctx.cycleTLS ? { type: 'cycletls', session: ctx.cycleTLS } : { type: 'fetch' };

        await downloadSegmentsParallel(
          result.newSegments,
          ctx.vodDir,
          baseURL,
          strategy,
          concurrency,
          HLS_SEGMENT_RETRY_ATTEMPTS,
          log,
          () => onProgress?.(downloadedSegments.size)
        );

        for (const seg of result.newSegments) downloadedSegments.add(seg.uri);
      }

      consecutiveErrors = 0;

      if (platform === PLATFORMS.KICK) {
        void updateChapterDuringDownload(ctx.ctx, ctx.dbId, vodId);
      }
      void updateVodDurationDuringDownload(ctx.ctx, ctx.dbId, vodId, platform, ctx.m3u8Path, variantM3u8String);

      await sleep(HLS_POLL_INTERVAL_MS);
    } catch (error) {
      const details = extractErrorDetails(error);

      if (error instanceof DownloadAbortedError) throw error;

      log.error({ ...details, vodId }, 'Poll cycle error');
      consecutiveErrors++;
      await sleep(getRetryDelay(consecutiveErrors));

      if (consecutiveErrors > HLS_MAX_CONSECUTIVE_ERRORS) {
        throw new Error(`Live HLS polling failed after ${consecutiveErrors} consecutive errors`);
      }
    }
  }
}

interface ArchivedVodContext {
  ctx: TenantContext;
  vodId: string;
  platform: Platform;
  sourceUrl?: string | undefined;
  vodDir: string;
  m3u8Path: string;
  cycleTLS: CycleTLSSession | null;
  log: AppLogger;
}

async function downloadArchivedVod(ctx: ArchivedVodContext): Promise<void> {
  const { vodId, platform, vodDir, m3u8Path, cycleTLS, log } = ctx;

  const playlist = await fetchPlaylistForArchived(ctx);

  if (!playlist) {
    throw new Error(`Failed to fetch HLS playlist for ${vodId}`);
  }

  const { variantM3u8String, baseURL } = playlist;

  await fsPromises.writeFile(m3u8Path, variantM3u8String);

  const parsed = HLS.parse(variantM3u8String) as HLS.types.MediaPlaylist;
  const segments = parsed.segments ?? [];

  if (segments.length === 0) {
    throw new Error('No segments found in HLS playlist');
  }

  log.debug({ vodId, count: segments.length }, `Found ${segments.length} segments to download`);

  const strategy: DownloadStrategy =
    platform === PLATFORMS.KICK && cycleTLS ? { type: 'cycletls', session: cycleTLS } : { type: 'fetch' };

  await downloadSegmentsParallel(
    segments,
    vodDir,
    baseURL,
    strategy,
    HLS_SEGMENT_CONCURRENCY,
    HLS_SEGMENT_RETRY_ATTEMPTS,
    log
  );
}

async function fetchPlaylist(ctx: LivePollingContext, retryCount: number) {
  const tenantId = ctx.ctx.tenantId;
  if (ctx.platform === PLATFORMS.TWITCH) {
    return fetchTwitchPlaylist(ctx.vodId, ctx.log, retryCount, HLS_MAX_CONSECUTIVE_ERRORS, tenantId);
  }
  return fetchKickPlaylist(
    ctx.vodId,
    ctx.sourceUrl,
    ctx.log,
    retryCount,
    HLS_MAX_CONSECUTIVE_ERRORS,
    ctx.cycleTLS ?? undefined
  );
}

async function fetchPlaylistForArchived(ctx: ArchivedVodContext) {
  const tenantId = ctx.ctx.tenantId;
  if (ctx.platform === PLATFORMS.TWITCH) {
    return fetchTwitchPlaylist(ctx.vodId, ctx.log, 0, HLS_MAX_CONSECUTIVE_ERRORS, tenantId);
  }
  return fetchKickPlaylist(ctx.vodId, ctx.sourceUrl, ctx.log, 0, HLS_MAX_CONSECUTIVE_ERRORS, ctx.cycleTLS ?? undefined);
}
