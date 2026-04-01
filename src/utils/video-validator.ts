import { getVodTokenSig, getM3u8 as getTwitchM3u8 } from '../services/twitch.js';
import HLSParser from 'hls-parser';
import type { MasterPlaylist, MediaPlaylist } from 'hls-parser/types';
import { extractErrorDetails } from './error.js';
import { logger } from './logger.js';

export async function validateVideoDuration(filePath: string): Promise<number | null> {
  try {
    const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';

    const { execFile } = await import('child_process');
    const util = await import('util');
    const execFileAsync = util.promisify(execFile);

    const { stdout } = await execFileAsync(ffprobePath, ['-v', 'quiet', '-print_format', 'json', '-show_format', filePath]);

    const probeData = JSON.parse(stdout);

    if (probeData.format && probeData.format.duration) {
      return parseFloat(probeData.format.duration);
    }

    return null;
  } catch (error) {
    const details = extractErrorDetails(error);
    logger.error({ filePath, ...details }, `Failed to validate video duration`);
    return null;
  }
}

export async function getTwitchHlsDuration(m3u8Path: string, vodId: string): Promise<number | null> {
  try {
    const tokenSig = await getVodTokenSig(vodId);

    let masterPlaylistContent: string;

    try {
      masterPlaylistContent = await getTwitchM3u8(vodId, tokenSig.value, tokenSig.signature);

      if (!masterPlaylistContent) {
        logger.error({ vodId }, 'Failed to fetch Twitch master playlist');
        return null;
      }
    } catch (error) {
      const details = extractErrorDetails(error);
      logger.error({ vodId, ...details }, 'Failed to fetch Twitch master playlist');
      return null;
    }

    const parsedMaster = HLSParser.parse(masterPlaylistContent) as MasterPlaylist;

    if (!parsedMaster || !parsedMaster.variants?.[0]?.uri) {
      logger.error({ vodId }, 'Invalid Twitch master playlist structure');
      return null;
    }

    const variantUrl = parsedMaster.variants[0].uri;

    // Construct the base URL for resolving relative paths (same as getTwitchM3u8)
    const baseUrl = `https://usher.ttvnw.net/vod/${vodId}.m3u8`;

    // Use native URL class for robust resolution of relative/absolute variant URLs
    const absoluteVariantUrl = new URL(variantUrl, baseUrl).href;

    const response = await fetch(absoluteVariantUrl);
    if (!response.ok) throw new Error(`Fetch failed with status ${response.status}`);
    
    // Fast path: extract Twitch's total seconds tag if present (avoids segment parsing overhead)
    const twitchTotalSecondsMatch = masterPlaylistContent.match(/#EXT-X-TWITCH-TOTAL-SECS:(\d+)/);
    if (twitchTotalSecondsMatch) {
      return parseInt(twitchTotalSecondsMatch[1], 10);
    }

    const variantM3u8String = await response.text();

    const parsedPlaylist = HLSParser.parse(variantM3u8String) as MediaPlaylist;

    if (!parsedPlaylist || !parsedPlaylist.segments?.length) {
      logger.error({ vodId }, 'No segments found in Twitch playlist');
      return null;
    }

    let totalDuration = 0;

    for (const segment of parsedPlaylist.segments) {
      if (segment.duration) {
        totalDuration += segment.duration;
      }
    }

    return Math.round(totalDuration);
  } catch (error) {
    const details = extractErrorDetails(error);
    logger.error({ vodId, ...details }, 'Failed to get Twitch HLS duration');
    return null;
  }
}

export async function compareDurations(actualSeconds: number, expectedSeconds: number, tolerancePercent = 5): Promise<{ valid: boolean; diffPercent: number }> {
  const diff = Math.abs(actualSeconds - expectedSeconds);
  const diffPercent = (diff / expectedSeconds) * 100;

  return {
    valid: diffPercent <= tolerancePercent,
    diffPercent: parseFloat(diffPercent.toFixed(2)),
  };
}
