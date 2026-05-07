import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import HLS from 'hls-parser';
import type { TenantConfig } from '../../config/types.js';
import { Hls } from '../../constants.js';
import { updateChapterDuringDownload } from '../../services/kick/index.js';
import { TenantContext } from '../../types/context.js';
import { PLATFORMS, type Platform } from '../../types/platforms.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { createSession, type CycleTLSSession } from '../../utils/cycletls.js';
import { sleep, getRetryDelay } from '../../utils/delay.js';
import { extractErrorDetails } from '../../utils/error.js';
import { HttpError } from '../../utils/http-error.js';
import type { AppLogger } from '../../utils/logger.js';
import { getVodDirPath, getVodFilePath } from '../../utils/path.js';
import { createVodWorkerAlerts, safeUpdateAlert } from '../utils/alert-factories.js';
import { convertHlsToMp4, detectFmp4FromPlaylist } from '../utils/ffmpeg.js';
import { updateVodDurationDuringDownload } from './duration-updater.js';
import { cleanupHlsFiles } from './hls-cleanup.js';
import {
  downloadSegmentsParallel,
  fetchTwitchPlaylist,
  fetchKickPlaylist,
  resolveDownloadStrategy,
} from './hls-utils.js';

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
  onProgress?: ((segmentsDownloaded: number, totalSegments: number) => void) | undefined;
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
  onFfmpegStart?: (cmd: string) => void;
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
  await mkdir(vodDir, { recursive: true });

  const m3u8Path = join(vodDir, `${vodId}.m3u8`);

  const cycleTLS = platform === PLATFORMS.KICK ? createSession() : null;
  if (cycleTLS) log.info({ vodId }, 'CycleTLS session created');

  try {
    if (isLive) {
      await runLivePollingLoop({
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
        concurrency: Hls.SEGMENT_CONCURRENCY,
        onProgress,
      });
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
        onProgress,
      });
    }

    let hlsFfmpegCmd: string | undefined;
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
            const alertData = createVodWorkerAlerts().converting(vodId, percent);
            if (hlsFfmpegCmd != null) {
              alertData.fields = [
                ...(alertData.fields ?? []),
                { name: 'FFmpeg', value: `\`${hlsFfmpegCmd.substring(0, 500)}\``, inline: false },
              ];
            }
            safeUpdateAlert(options.discordMessageId, alertData, log, vodId);
          }
        },
        onFfmpegStart: (cmd) => {
          hlsFfmpegCmd = cmd;
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

  const m3u8Content = await readFile(m3u8Path, 'utf8');
  const isFmp4 = detectFmp4FromPlaylist(m3u8Content);

  log.info({ vodId, isFmp4 }, 'Converting HLS to MP4');
  await convertHlsToMp4(m3u8Path, finalMp4Path, {
    vodId,
    isFmp4,
    ...(options.onConversionProgress && { onProgress: options.onConversionProgress }),
    ...(options.onFfmpegStart && { onStart: options.onFfmpegStart }),
  });

  const files = await readdir(vodDir);
  const segmentCount = files.filter((f) => f.endsWith('.mp4') || f.endsWith('.ts')).length;

  const shouldKeepHls = config.settings.saveHLS ?? false;
  if (shouldKeepHls) {
    log.info({ vodId }, 'Preserving HLS files (saveHLS=true)');
  } else {
    log.info({ vodId }, 'Cleaning up HLS files');
  }
  await cleanupHlsFiles(vodDir, shouldKeepHls, finalMp4Path, log);

  return { segmentCount, finalMp4Path };
}

export function filterNewSegments(
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

  const isStreamEnd = noChangeCount >= Hls.NO_CHANGE_THRESHOLD;

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
  onProgress?: ((segmentsDownloaded: number, totalSegments: number) => void) | undefined;
}

async function runLivePollingLoop(ctx: LivePollingContext): Promise<void> {
  const { vodId, platform, log, concurrency, onProgress } = ctx;

  let consecutiveErrors = 0;
  let noChangePollCount = 0;
  let lastSegmentUri: string | null = null;

  const downloadedSegments = new Set<string>(
    await readdir(ctx.vodDir).then((files) => files.filter((f) => f.endsWith('.ts') || f.endsWith('.mp4')))
  );

  let streamEnded = false;
  while (!streamEnded) {
    try {
      const playlist = await fetchPlaylist(ctx, {
        attempts: 3,
        baseDelayMs: 2000,
        shouldRetry: (err) => err instanceof HttpError && (err.statusCode === 403 || err.statusCode >= 500),
      });

      const { variantM3u8String, baseURL } = playlist;
      const parsed = HLS.parse(variantM3u8String) as HLS.types.MediaPlaylist;
      const segments = parsed.segments ?? [];

      await writeFile(ctx.m3u8Path, variantM3u8String);

      const result = filterNewSegments(segments, downloadedSegments, lastSegmentUri, noChangePollCount);

      if (result.isStreamEnd) {
        log.info({ vodId }, 'Stream end detected');
        streamEnded = true;
        break;
      }

      if (noChangePollCount > 0 && result.newNoChangeCount === 0) {
        log.info({ vodId, resumedAfter: noChangePollCount }, 'New segments resumed');
      }

      lastSegmentUri = result.newLastSegmentUri;
      noChangePollCount = result.newNoChangeCount;

      if (result.newSegments.length > 0) {
        const strategy = resolveDownloadStrategy(platform, ctx.cycleTLS);

        const totalDuration = segments.reduce((sum, seg) => sum + (seg.duration ?? 0), 0);

        await downloadSegmentsParallel(
          result.newSegments,
          ctx.vodDir,
          baseURL,
          strategy,
          concurrency,
          Hls.SEGMENT_RETRY_ATTEMPTS,
          log,
          (_completedCount) => onProgress?.(downloadedSegments.size, totalDuration)
        );

        for (const seg of result.newSegments) downloadedSegments.add(seg.uri);
      }

      consecutiveErrors = 0;

      if (platform === PLATFORMS.KICK) {
        void updateChapterDuringDownload(ctx.ctx, ctx.dbId, vodId);
      }
      void updateVodDurationDuringDownload(ctx.ctx, ctx.dbId, vodId, platform, ctx.m3u8Path, variantM3u8String);

      await sleep(Hls.POLL_INTERVAL_MS);
    } catch (error) {
      const details = extractErrorDetails(error);

      log.error({ ...details, vodId }, 'Poll cycle error');
      consecutiveErrors++;
      await sleep(getRetryDelay(consecutiveErrors));

      if (consecutiveErrors > Hls.MAX_CONSECUTIVE_ERRORS) {
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
  onProgress?: ((segmentsDownloaded: number, totalSegments: number) => void) | undefined;
}

async function downloadArchivedVod(ctx: ArchivedVodContext): Promise<void> {
  const { vodId, platform, vodDir, m3u8Path, cycleTLS, log, onProgress } = ctx;

  const playlist = await fetchPlaylist(ctx, { attempts: 3, baseDelayMs: 2000 });

  const { variantM3u8String, baseURL } = playlist;

  await writeFile(m3u8Path, variantM3u8String);

  const parsed = HLS.parse(variantM3u8String) as HLS.types.MediaPlaylist;
  const segments = parsed.segments ?? [];

  if (segments.length === 0) {
    throw new Error('No segments found in HLS playlist');
  }

  log.debug({ vodId, count: segments.length }, 'Found segments to download');

  const strategy = resolveDownloadStrategy(platform, cycleTLS);

  await downloadSegmentsParallel(
    segments,
    vodDir,
    baseURL,
    strategy,
    Hls.SEGMENT_CONCURRENCY,
    Hls.SEGMENT_RETRY_ATTEMPTS,
    log,
    (completedCount) => onProgress?.(completedCount, segments.length)
  );
}

export async function fetchPlaylist(
  ctx: LivePollingContext | ArchivedVodContext,
  retryOptions?: {
    attempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    shouldRetry?: (error: unknown) => boolean;
  }
) {
  const tenantId = ctx.ctx.tenantId;

  if (ctx.platform === PLATFORMS.TWITCH) {
    return fetchTwitchPlaylist(ctx.vodId, ctx.log, tenantId, retryOptions);
  }
  return fetchKickPlaylist(ctx.vodId, ctx.sourceUrl, ctx.log, ctx.cycleTLS ?? undefined, retryOptions);
}
