import { getVodTokenSig, getM3u8 as getTwitchM3u8 } from '../services/twitch.js';
import HLS from 'hls-parser';
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

    const parsedMaster: any = HLS.parse(masterPlaylistContent);

    if (!parsedMaster || !parsedMaster.variants?.[0]?.uri) {
      logger.error({ vodId }, 'Invalid Twitch master playlist structure');
      return null;
    }

    const variantUrl = parsedMaster.variants[0].uri;

    let baseURL: string;
    let variantM3u8String: string;

    if (!variantUrl.startsWith('http')) {
      baseURL = masterPlaylistContent.substring(0, masterPlaylistContent.lastIndexOf('/'));

      const response1 = await fetch(variantUrl.includes('/') ? variantUrl : `${baseURL}/${variantUrl}`);
      if (!response1.ok) throw new Error(`Fetch failed with status ${response1.status}`);
      variantM3u8String = await response1.text();
    } else {
      baseURL = variantUrl.substring(0, variantUrl.lastIndexOf('/'));

      const response2 = await fetch(variantUrl);
      if (!response2.ok) throw new Error(`Fetch failed with status ${response2.status}`);
      variantM3u8String = await response2.text();
    }

    const parsedPlaylist: any = HLS.parse(variantM3u8String);

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
