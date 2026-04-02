import HLS from 'hls-parser';
import fsPromises from 'fs/promises';
import path from 'path';
import { createSession } from '../utils/cycletls.js';
import { navigateToUrl } from '../utils/puppeteer-manager.js';
import dayjs from 'dayjs';
import durationPlugin from 'dayjs/plugin/duration';
import { extractErrorDetails } from '../utils/error.js';
import { childLogger } from '../utils/logger.js';

dayjs.extend(durationPlugin);

const log = childLogger({ module: 'kick' });

/**
 * Fetches Kick's HLS playlist using cycletls (JA3 fingerprinting).
 */
export async function getKickM3u8(sourceUrl: string): Promise<string> {
  const session = createSession();

  try {
    return await session.fetchText(sourceUrl);
  } finally {
    await session.close();
  }
}

/**
 * Extract best variant URL from master playlist - matches reference getParsedM3u8 (lines 207-216)
 */
export function getKickParsedM3u8(m3u8: string, baseURL: string): string | null {
  try {
    const parsed = HLS.parse(m3u8);

    if (!parsed || !('variants' in parsed) || parsed.variants.length === 0) {
      return null;
    }

    // Select highest quality variant (first one in the list) - matches reference line 214-215
    const bestVariant = parsed.variants[0];

    if (!bestVariant.uri) {
      return null;
    }

    return `${baseURL}/${bestVariant.uri}`;
  } catch (error) {
    const details = extractErrorDetails(error);
    log.debug({ details }, 'Failed to parse HLS master playlist');
    return null;
  }
}

/**
 * Live stream data structure - matches reference getStream (lines 48-73)
 */
export interface KickStreamStatus {
  id: string;
  session_title?: string | null;
  created_at: string;
  playback_url?: string | null; // HLS master playlist URL with auth token
  viewers?: number | null;
  slug?: string | null;
  language?: string | null;
  is_mature?: boolean | null;
  category?: {
    id: number;
    name?: string | null;
    slug?: string | null;
  } | null;
}

export interface KickVod {
  id: string;
  slug?: string | null;
  channel_id?: number | null;
  title?: string | null;
  session_title?: string | null;
  duration?: number | null;
  views?: number | null;
  published_at?: string | null;
  created_at: string;
  source?: string | null;
  is_live?: boolean | null;
  start_time?: string | null;
  language?: string | null;
  is_mature?: boolean | null;
  viewer_count?: number | null;
  tags?: string[] | null;
  thumbnail?: {
    src?: string | null;
    srcset?: string | null;
  } | null;
}

export async function getVods(channelName: string): Promise<KickVod[]> {
  const result = await navigateToUrl(`https://kick.com/api/v2/channels/${channelName}/videos`);

  if (!result.success) {
    throw new Error('Failed to load Kick videos API after retries'); // Updated message - matches reference line 75-100 pattern
  }

  const page = result.page;

  try {
    // Wait briefly for response to be ready (replaces legacy code's 10s sleep with shorter wait) - matches reference line 85-96 pattern
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const content = await page.content();

    try {
      const data = JSON.parse(content); // Parse API response directly (not Next.js script) - matches reference lines 75-100

      if (!data || !Array.isArray(data)) {
        return [];
      }

      // Map raw video objects to KickVod interface - matches reference line 92-96 pattern
      const vodsData = data.map((video: Record<string, unknown>) => ({
        id: String(video.id),
        slug: (video.slug as string) ?? null,
        title: (video.title as string) ?? null,
        session_title: (video.session_title as string) ?? null,
        duration: video.duration ? Number(video.duration) : null,
        views: video.views ? Number(video.views) : null,
        published_at: (video.publishedAt as string) ?? null,
        created_at: String(video.createdAt || ''),
        source: (video.source as string) ?? null,
      }));

      return vodsData; // Return mapped VOD array - matches reference line 96 pattern
    } catch (error) {
      const details = extractErrorDetails(error);
      log.debug({ channelName, details }, 'Failed to parse videos API JSON response');
      return []; // Empty on parse error
    }
  } finally {
    await page.close();
  }
}

export async function getVod(channelName: string, vodId: string): Promise<KickVod> {
  const result = await navigateToUrl(`https://kick.com/api/v2/channels/${channelName}/videos`); // Use API endpoint instead of Next.js page - matches reference line 103-134 pattern

  if (!result.success) {
    throw new Error('Failed to load Kick videos API after retries');
  }

  const page = result.page;

  try {
    // Wait briefly for response (replaces legacy code's sleep with shorter wait) - matches reference line 108-129 pattern
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const content = await page.content();
    const data: Record<string, unknown>[] = JSON.parse(content); // Parse API response directly (not Next.js script) - matches reference lines 75-100 pattern

    if (!Array.isArray(data)) {
      throw new Error(`VOD ${vodId} not found`);
    }

    // Find matching VOD by ID (matches reference line 128-134: jsonContent.find((livestream) => livestream.id.toString() === vodId))
    const video = data.find((v) => v && String(v?.id) === vodId);

    if (!video || typeof video !== 'object') {
      throw new Error(`VOD ${vodId} not found`);
    }

    return {
      id: String(video.id),
      slug: (video.slug as string) ?? null,
      title: (video.title as string) ?? null,
      session_title: (video.session_title as string) ?? null,
      duration: video.duration ? Number(video.duration) : null,
      views: video.views ? Number(video.views) : null,
      published_at: (video.publishedAt as string) ?? null,
      created_at: String(video.createdAt || ''),
      source: (video.source as string) ?? null,
    };
  } finally {
    await page.close();
  }
}

/**
 * Download VOD as MP4 using cycletls for segment downloads - matches reference downloadMP4 (lines 136-175) + getParsedM3u8 pattern
 */
export async function downloadMP4(_streamerId: string, vod: KickVod): Promise<string> {
  if (!vod.source) {
    throw new Error('VOD source URL not available');
  }

  const { getStreamerConfig } = await import('../config/loader.js');

  const config = getStreamerConfig(_streamerId);

  if (!config?.settings.vodPath) {
    throw new Error(`No vodPath configured for streamer ${_streamerId}`);
  }

  // Use tenant's vodPath (matches hls-downloader.ts line 272 pattern: /{vodPath}/{tenantId}/tmp/)
  const outputDir = path.join(config.settings.vodPath, _streamerId, 'tmp');

  try {
    await fsPromises.mkdir(outputDir, { recursive: true });
  } catch (error) {
    log.debug({ error: extractErrorDetails(error).message }, 'mkdir failed - directory may already exist');
  }

  const outputPath = path.join(outputDir, `${vod.id}.mp4`);

  // Create session for entire download (matches reference pattern lines 170-205 + 468)
  const session = createSession();

  try {
    // Fetch HLS master playlist using cycletls - matches reference line 139 & getM3u8 function lines 177-205
    const m3u8Content = await session.fetchText(vod.source);

    if (!m3u8Content) {
      throw new Error('Empty HLS playlist response from Kick');
    }

    // Parse master playlist and extract best variant URL using getParsedM3u8 helper - matches reference line 140 & lines 207-216
    const baseURL = vod.source.replace('/master.m3u8', '');

    let variantUrl: string | null;

    if (vod.source.includes('master.m3u8')) {
      // Use getParsedM3u8 for master playlists - matches reference line 140 & lines 207-216
      variantUrl = getKickParsedM3u8(m3u8Content, baseURL);

      if (!variantUrl) {
        throw new Error('No video variants found in HLS playlist');
      }
    } else {
      // Direct media playlist URL - use as-is (matches reference downloadHLS line 462 pattern + getM3u8 usage lines 179-205)
      variantUrl = vod.source;
    }

    // Fetch media/variant playlist using cycletls - matches reference pattern line 462 & downloadTSFiles setup lines 467-509
    const variantM3u8Content = await session.fetchText(variantUrl);

    // Parse media playlist to get segments (matches reference downloadHLS line 464: m3u8 = HLS.parse(m3u8))
    const mediaPlaylist: HLS.types.MediaPlaylist | null = HLS.parse(variantM3u8Content) as HLS.types.MediaPlaylist;

    if (!mediaPlaylist || !('segments' in mediaPlaylist)) {
      throw new Error('Failed to parse variant playlist');
    }

    // Write m3u8 file for ffmpeg (matches reference line 471-475: fs.writeFileSync(`${dir}/${vodId}.m3u8`, HLS.stringify(m3u8)))
    const tempM3u8Path = path.join(outputDir, `${vod.id}.m3u8`);

    try {
      await fsPromises.writeFile(variantM3u8Content, tempM3u8Path);
    } catch (error) {
      log.debug({ error: extractErrorDetails(error).message }, 'writeFile failed');
    }

    // Download ALL TS segments sequentially using cycletls - matches reference downloadTSFiles function lines 476-501 (exact sequential approach for Kick platform only as requested)
    const mediaPlaylistSegments = 'segments' in mediaPlaylist ? mediaPlaylist.segments : [];

    if (!mediaPlaylistSegments || mediaPlaylistSegments.length === 0) {
      throw new Error('No segments found in variant playlist');
    }

    // Determine correct baseURL for segment downloads - matches reference downloadHLS lines 395-462 & getM3u8 usage pattern
    let segmentBaseURL: string;

    if (vod.source.includes('master.m3u8')) {
      // For master playlists, use the variant playlist's base URL (matches reference line 179-205 + downloadHLS lines 467-509 pattern)
      segmentBaseURL = variantUrl.substring(0, variantUrl.lastIndexOf('/'));
    } else {
      // Direct media playlist - extract baseURL from source itself
      segmentBaseURL = vod.source.substring(0, vod.source.lastIndexOf('/'));
    }

    // Download each TS file sequentially using cycletls session.streamToFile (matches reference downloadTSFiles lines 476-501 exactly)
    for (const segment of mediaPlaylistSegments) {
      const outputPathSegment = path.join(outputDir, segment.uri);

      try {
        await fsPromises.access(outputPathSegment); // Check if exists - matches reference line 476-477: "if (await fileExists(`${dir}/${segment.uri}`)) continue;"
        continue; // Skip existing files
      } catch (error) {
        const details = extractErrorDetails(error);
        if (!details.message.includes('ENOENT')) {
          /* not expected */
        }
        // File doesn't exist, download with cycletls using streamToFile (matches reference lines 478-501 exactly)
        const segmentUrl = `${segmentBaseURL}/${segment.uri}`;

        await session.streamToFile(segmentUrl, outputPathSegment);
      }
    }

    // Now use ffmpeg to concatenate m3u8 file into MP4 - matches reference downloadMP4 lines 169-205 pattern
    const { convertHlsToMp4 } = await import('../utils/ffmpeg.js');

    await convertHlsToMp4(tempM3u8Path, vod.id, outputPath);

    return outputPath;
  } finally {
    // Clean exit - matches reference line 509: "await cycleTLS.exit();"
    await session.close();
  }
}

export default downloadMP4;
