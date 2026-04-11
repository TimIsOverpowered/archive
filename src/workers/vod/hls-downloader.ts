// vod/hls-downloader.ts
import fsPromises from 'fs/promises';
import pathMod from 'path';
import HLS from 'hls-parser';
import { extractErrorDetails } from '../../utils/error.js';
import { getTenantConfig } from '../../config/loader.js';
import { getClient } from '../../db/client.js';
import { getVodDirPath } from '../../utils/path.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { createSession, type CycleTLSSession } from '../../utils/cycletls.js';
import { updateChapterDuringDownload } from '../../services/kick.js';
import { downloadSegmentsParallel, fetchTwitchPlaylist, fetchKickPlaylist, type DownloadStrategy } from './hls-utils.js';
import { sleep, getRetryDelay } from '../../utils/delay.js';

export interface HlsDownloadOptions {
  dbId: number;
  vodId: string;
  platform: 'twitch' | 'kick';
  tenantId: string;
  platformUserId: string;
  platformUsername?: string;
  startedAt?: string;
  sourceUrl?: string;
  onProgress?: (segmentsDownloaded: number) => void; // caller owns alerting
}

export interface HlsDownloadResult {
  success: true;
  m3u8Path: string;
  outputDir: string;
  segmentCount: number;
}

const MAX_CONSECUTIVE_ERRORS = 12;
const NO_CHANGE_THRESHOLD = 5; // 5 × 60s = 5 min end detection
const POLL_INTERVAL_MS = 60_000;
const SEGMENT_CONCURRENCY = 5;
const SEGMENT_RETRY_ATTEMPTS = 3;

export async function downloadLiveHls(options: HlsDownloadOptions): Promise<HlsDownloadResult> {
  const { dbId, vodId, platform, tenantId, startedAt, sourceUrl, onProgress } = options;
  const log = createAutoLogger(tenantId);

  const streamerClient = getClient(tenantId);
  if (!streamerClient) throw new Error(`DB client not available for ${tenantId}`);

  const config = getTenantConfig(tenantId);
  if (!config?.settings.vodPath) throw new Error(`VOD path not configured for ${tenantId}`);

  const vodDir = getVodDirPath({ tenantId, vodId });
  await fsPromises.mkdir(vodDir, { recursive: true });

  const m3u8Path = pathMod.join(vodDir, `${vodId}.m3u8`);

  const cycleTLS = platform === 'kick' ? createSession() : null;
  if (cycleTLS) log.info(`[${vodId}] CycleTLS session created`);

  try {
    await runPollingLoop({
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
      onProgress,
    });
  } finally {
    if (cycleTLS) {
      await cycleTLS.close();
      log.info(`[${vodId}] CycleTLS session closed`);
    }
  }

  const files = await fsPromises.readdir(vodDir);
  const segmentCount = files.filter((f) => f.endsWith('.mp4') || f.endsWith('.ts')).length;

  log.info({ vodId, platform, segmentCount }, '[HLS-Downloader] Download complete');

  return { success: true, m3u8Path, outputDir: vodDir, segmentCount };
}

// --- Polling loop ---

interface PollingContext {
  vodId: string;
  platform: 'twitch' | 'kick';
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
}

async function runPollingLoop(ctx: PollingContext): Promise<void> {
  const { vodId, platform, log } = ctx;

  let consecutiveErrors = 0;
  let noChangePollCount = 0;
  let lastSegmentUri: string | null = null;

  // Cache existing segments to avoid per-segment fs calls inside loop
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

      // Stream end detection
      if (currentLastUri && currentLastUri === lastSegmentUri) {
        noChangePollCount++;
        log.info(`[${vodId}] No new segments (${noChangePollCount}/${NO_CHANGE_THRESHOLD})`);
        if (noChangePollCount >= NO_CHANGE_THRESHOLD) {
          log.info(`[${vodId}] Stream end detected`);
          break;
        }
      } else {
        if (noChangePollCount > 0) log.info(`[${vodId}] New segments resumed after ${noChangePollCount} idle polls`);
        lastSegmentUri = currentLastUri;
        noChangePollCount = 0;
      }

      await fsPromises.writeFile(ctx.m3u8Path, variantM3u8String);

      const newSegments = segments.filter((seg) => !downloadedSegments.has(seg.uri));

      if (newSegments.length > 0) {
        const strategy: DownloadStrategy = platform === 'kick' && ctx.cycleTLS ? { type: 'cycletls', session: ctx.cycleTLS } : { type: 'fetch' };

        await downloadSegmentsParallel(newSegments, ctx.vodDir, baseURL, strategy, SEGMENT_CONCURRENCY, SEGMENT_RETRY_ATTEMPTS, log, () => ctx.onProgress?.(downloadedSegments.size));

        for (const seg of newSegments) downloadedSegments.add(seg.uri);
      }

      consecutiveErrors = 0; // only reset on full successful poll

      if (platform === 'kick') {
        await updateChapterDuringDownload(ctx.dbId, vodId, ctx.tenantId, ctx.streamerClient);
      }

      await sleep(POLL_INTERVAL_MS);
    } catch (error) {
      const details = extractErrorDetails(error);

      if (details.message === 'Download aborted') throw error;

      log.error({ ...details, vodId }, `[${vodId}] Poll cycle error`);
      consecutiveErrors++;
      await sleep(getRetryDelay(consecutiveErrors));

      if (consecutiveErrors > MAX_CONSECUTIVE_ERRORS) {
        throw new Error(`Live HLS polling failed after ${consecutiveErrors} consecutive errors`);
      }
    }
  }
}

async function fetchPlaylist(ctx: PollingContext, retryCount: number) {
  if (ctx.platform === 'twitch') {
    return fetchTwitchPlaylist(ctx.vodId, ctx.log, retryCount, MAX_CONSECUTIVE_ERRORS);
  }
  return fetchKickPlaylist(ctx.vodId, ctx.sourceUrl, ctx.log, retryCount, MAX_CONSECUTIVE_ERRORS, ctx.cycleTLS ?? undefined);
}

export default downloadLiveHls;
