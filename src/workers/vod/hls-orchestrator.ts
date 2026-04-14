import fsPromises from 'fs/promises';
import pathMod from 'path';
import HLS from 'hls-parser';
import { extractErrorDetails } from '../../utils/error.js';
import { getTenantConfig } from '../../config/loader.js';
import { getClient } from '../../db/client.js';
import { getVodDirPath, getVodFilePath } from '../../utils/path.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { createSession, type CycleTLSSession } from '../../utils/cycletls.js';
import { updateChapterDuringDownload } from '../../services/kick.js';
import { downloadSegmentsParallel, fetchTwitchPlaylist, fetchKickPlaylist, type DownloadStrategy } from './hls-utils.js';
import { sleep, getRetryDelay } from '../../utils/delay.js';
import { convertHlsToMp4, detectFmp4FromPlaylist } from './ffmpeg.js';
import { HLS_MAX_CONSECUTIVE_ERRORS, HLS_NO_CHANGE_THRESHOLD, HLS_POLL_INTERVAL_MS, HLS_SEGMENT_CONCURRENCY, HLS_SEGMENT_RETRY_ATTEMPTS } from '../../constants.js';
import { PLATFORMS, type Platform } from '../../types/platforms.js';

export interface HlsDownloadOptions {
  dbId: number;
  vodId: string;
  platform: Platform;
  tenantId: string;
  platformUserId: string;
  platformUsername?: string;
  startedAt?: string;
  sourceUrl?: string;
  isLive?: boolean;
  onProgress?: (segmentsDownloaded: number) => void;
}

export interface HlsDownloadResult {
  success: true;
  m3u8Path: string;
  outputDir: string;
  segmentCount: number;
  finalMp4Path: string;
}

export async function downloadHlsStream(options: HlsDownloadOptions): Promise<HlsDownloadResult> {
  const { dbId, vodId, platform, tenantId, startedAt, sourceUrl, isLive = false, onProgress } = options;
  const log = createAutoLogger(tenantId);

  const streamerClient = getClient(tenantId);
  if (!streamerClient) throw new Error(`DB client not available for ${tenantId}`);

  const config = getTenantConfig(tenantId);
  if (!config?.settings.vodPath) throw new Error(`VOD path not configured for ${tenantId}`);

  const concurrency = HLS_SEGMENT_CONCURRENCY;

  const vodDir = getVodDirPath({ tenantId, vodId });
  const finalMp4Path = getVodFilePath({ tenantId, vodId });
  await fsPromises.mkdir(vodDir, { recursive: true });

  const m3u8Path = pathMod.join(vodDir, `${vodId}.m3u8`);

  const cycleTLS = platform === PLATFORMS.KICK ? createSession() : null;
  if (cycleTLS) log.info({ vodId }, 'CycleTLS session created');

  try {
    if (isLive) {
      await runLivePollingLoop({
        vodId,
        platform,
        tenantId,
        dbId,
        sourceUrl,
        startedAt,
        vodDir,
        m3u8Path,
        cycleTLS,
        streamerClient,
        log,
        concurrency,
        onProgress,
      });
    } else {
      await downloadArchivedVod({
        vodId,
        platform,
        tenantId,
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
    await convertHlsToMp4(m3u8Path, finalMp4Path, { vodId, isFmp4 });

    const files = await fsPromises.readdir(vodDir);
    const segmentCount = files.filter((f) => f.endsWith('.mp4') || f.endsWith('.ts')).length;

    log.info({ vodId, platform, segmentCount }, 'HLS download and conversion complete');

    return { success: true, m3u8Path, outputDir: vodDir, segmentCount, finalMp4Path };
  } finally {
    if (cycleTLS) {
      await cycleTLS.close();
      log.info({ vodId }, 'CycleTLS session closed');
    }
  }
}

interface LivePollingContext {
  vodId: string;
  platform: Platform;
  tenantId: string;
  dbId: number;
  sourceUrl?: string;
  startedAt?: string;
  vodDir: string;
  m3u8Path: string;
  cycleTLS: CycleTLSSession | null;
  streamerClient: NonNullable<ReturnType<typeof getClient>>;
  log: ReturnType<typeof createAutoLogger>;
  onProgress?: (segmentsDownloaded: number) => void;
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
        const strategy: DownloadStrategy = platform === PLATFORMS.KICK && ctx.cycleTLS ? { type: 'cycletls', session: ctx.cycleTLS } : { type: 'fetch' };

        await downloadSegmentsParallel(newSegments, ctx.vodDir, baseURL, strategy, concurrency, HLS_SEGMENT_RETRY_ATTEMPTS, log, () => ctx.onProgress?.(downloadedSegments.size));

        for (const seg of newSegments) downloadedSegments.add(seg.uri);
      }

      consecutiveErrors = 0;

      if (platform === PLATFORMS.KICK) {
        await updateChapterDuringDownload(ctx.dbId, vodId, ctx.tenantId, ctx.streamerClient);
      }

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
  vodId: string;
  platform: Platform;
  tenantId: string;
  sourceUrl?: string;
  vodDir: string;
  m3u8Path: string;
  cycleTLS: CycleTLSSession | null;
  log: ReturnType<typeof createAutoLogger>;
}

async function downloadArchivedVod(ctx: ArchivedVodContext): Promise<void> {
  const { vodId, platform, vodDir, m3u8Path, cycleTLS, log } = ctx;

  const concurrency = HLS_SEGMENT_CONCURRENCY;

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

  const strategy: DownloadStrategy = platform === PLATFORMS.KICK && cycleTLS ? { type: 'cycletls', session: cycleTLS } : { type: 'fetch' };

  await downloadSegmentsParallel(segments, vodDir, baseURL, strategy, concurrency, HLS_SEGMENT_RETRY_ATTEMPTS, log);
}

async function fetchPlaylist(ctx: LivePollingContext, retryCount: number) {
  if (ctx.platform === PLATFORMS.TWITCH) {
    return fetchTwitchPlaylist(ctx.vodId, ctx.log, retryCount, HLS_MAX_CONSECUTIVE_ERRORS, ctx.tenantId);
  }
  return fetchKickPlaylist(ctx.vodId, ctx.sourceUrl, ctx.log, retryCount, HLS_MAX_CONSECUTIVE_ERRORS, ctx.cycleTLS ?? undefined);
}

async function fetchPlaylistForArchived(ctx: ArchivedVodContext) {
  if (ctx.platform === PLATFORMS.TWITCH) {
    return fetchTwitchPlaylist(ctx.vodId, ctx.log, 0, HLS_MAX_CONSECUTIVE_ERRORS, ctx.tenantId);
  }
  return fetchKickPlaylist(ctx.vodId, ctx.sourceUrl, ctx.log, 0, HLS_MAX_CONSECUTIVE_ERRORS, ctx.cycleTLS ?? undefined);
}
