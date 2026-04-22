import fsPromises from 'fs/promises';
import pathMod from 'path';
import HLS from 'hls-parser';
import { extractErrorDetails } from '../../utils/error.js';
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

export async function downloadHlsStream(options: HlsDownloadOptions): Promise<HlsDownloadResult> {
  const { ctx, dbId, vodId, platform, startedAt, sourceUrl, isLive = false, onProgress } = options;
  const { config, tenantId } = ctx;
  const log = createAutoLogger(tenantId);

  if (!config?.settings.vodPath) throw new Error(`VOD path not configured for ${tenantId}`);

  const concurrency = HLS_SEGMENT_CONCURRENCY;

  const vodDir = getVodDirPath({ config, vodId });
  const finalMp4Path = getVodFilePath({ config, vodId });
  await fsPromises.mkdir(vodDir, { recursive: true });

  const m3u8Path = pathMod.join(vodDir, `${vodId}.m3u8`);

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
        concurrency,
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
      });
    }

    const m3u8Content = await fsPromises.readFile(m3u8Path, 'utf8');
    const isFmp4 = detectFmp4FromPlaylist(m3u8Content);

    log.info({ vodId, isFmp4 }, 'Converting HLS to MP4');
    const alerts = createVodWorkerAlerts();
    await convertHlsToMp4(m3u8Path, finalMp4Path, {
      vodId,
      isFmp4,
      onProgress: (percent) => {
        if (options.discordMessageId) {
          void updateAlert(options.discordMessageId, alerts.progress(vodId, `Converting ${vodId} (${percent}%)`));
        }
      },
    });

    const files = await fsPromises.readdir(vodDir);
    const segmentCount = files.filter((f) => f.endsWith('.mp4') || f.endsWith('.ts')).length;

    log.info({ vodId, platform, segmentCount }, 'HLS download and conversion complete');

    const shouldKeepHls = config.settings.saveHLS ?? false;
    if (shouldKeepHls) {
      log.info({ vodId }, 'Preserving HLS files (saveHLS=true)');
    } else {
      log.info({ vodId }, 'Cleaning up HLS files');
    }
    await cleanupHlsFiles(vodDir, shouldKeepHls, log);

    return { success: true, m3u8Path, outputDir: vodDir, segmentCount, finalMp4Path };
  } finally {
    if (cycleTLS) {
      await cycleTLS.close();
      log.info({ vodId }, 'CycleTLS session closed');
    }
  }
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
  onProgress?: ((segmentsDownloaded: number) => void) | undefined;
  concurrency: number;
}

async function runLivePollingLoop(ctx: LivePollingContext): Promise<void> {
  const { vodId, platform, log, concurrency } = ctx;

  let consecutiveErrors = 0;
  let noChangePollCount = 0;
  let lastSegmentUri: string | null = null;

  const downloadedSegments = new Set(await fsPromises.readdir(ctx.vodDir));

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
      const currentLastUri = segments.at(-1)?.uri ?? '';

      if (currentLastUri && currentLastUri === lastSegmentUri) {
        noChangePollCount++;
        log.info({ vodId, pollCount: noChangePollCount, threshold: HLS_NO_CHANGE_THRESHOLD }, 'No new segments');
        if (noChangePollCount >= HLS_NO_CHANGE_THRESHOLD) {
          log.info({ vodId }, 'Stream end detected');
          break;
        }
      } else {
        if (noChangePollCount > 0) log.info({ vodId, resumedAfter: noChangePollCount }, 'New segments resumed');
        lastSegmentUri = currentLastUri;
        noChangePollCount = 0;
      }

      await fsPromises.writeFile(ctx.m3u8Path, variantM3u8String);

      const newSegments = segments.filter((seg) => !downloadedSegments.has(seg.uri));

      if (newSegments.length > 0) {
        const strategy: DownloadStrategy =
          platform === PLATFORMS.KICK && ctx.cycleTLS ? { type: 'cycletls', session: ctx.cycleTLS } : { type: 'fetch' };

        await downloadSegmentsParallel(
          newSegments,
          ctx.vodDir,
          baseURL,
          strategy,
          concurrency,
          HLS_SEGMENT_RETRY_ATTEMPTS,
          log,
          () => ctx.onProgress?.(downloadedSegments.size)
        );

        for (const seg of newSegments) downloadedSegments.add(seg.uri);
      }

      consecutiveErrors = 0;

      if (platform === PLATFORMS.KICK) {
        await updateChapterDuringDownload(ctx.ctx, ctx.dbId, vodId);
      }

      // Fire-and-forget duration update
      void updateVodDurationDuringDownload(ctx.ctx, ctx.dbId, vodId, platform, ctx.m3u8Path, variantM3u8String);

      await sleep(HLS_POLL_INTERVAL_MS);
    } catch (error) {
      const details = extractErrorDetails(error);

      if (details.message === 'Download aborted') throw error;

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

  const concurrency = HLS_SEGMENT_CONCURRENCY;

  const playlist = await fetchPlaylistForArchived(ctx as ArchivedVodContext & { ctx?: TenantContext });

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

  await downloadSegmentsParallel(segments, vodDir, baseURL, strategy, concurrency, HLS_SEGMENT_RETRY_ATTEMPTS, log);
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

async function fetchPlaylistForArchived(ctx: ArchivedVodContext & { ctx?: TenantContext }) {
  const tenantId = ctx.ctx?.tenantId;
  if (!tenantId) throw new Error('tenantId required for archived vod download');
  if (ctx.platform === PLATFORMS.TWITCH) {
    return fetchTwitchPlaylist(ctx.vodId, ctx.log, 0, HLS_MAX_CONSECUTIVE_ERRORS, tenantId);
  }
  return fetchKickPlaylist(ctx.vodId, ctx.sourceUrl, ctx.log, 0, HLS_MAX_CONSECUTIVE_ERRORS, ctx.cycleTLS ?? undefined);
}
