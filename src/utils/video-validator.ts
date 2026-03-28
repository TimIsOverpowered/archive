import { getVodTokenSig, getM3u8 as getTwitchM3u8 } from '../services/twitch.js';
import HLS from 'hls-parser';
import axios from 'axios';

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
    console.error(`Failed to validate video duration for ${filePath}:`, error instanceof Error ? error.message : error);
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
        console.error(`Failed to fetch Twitch master playlist for ${vodId}`);
        return null;
      }
    } catch (error) {
      console.error(`Error fetching Twitch HLS:`, error instanceof Error ? error.message : error);
      return null;
    }

    const parsedMaster: any = HLS.parse(masterPlaylistContent);

    if (!parsedMaster || !parsedMaster.variants?.[0]?.uri) {
      console.error(`Invalid Twitch master playlist structure for ${vodId}`);
      return null;
    }

    const variantUrl = parsedMaster.variants[0].uri;

    let baseURL: string;
    let variantM3u8String: string;

    if (!variantUrl.startsWith('http')) {
      baseURL = masterPlaylistContent.substring(0, masterPlaylistContent.lastIndexOf('/'));
      variantM3u8String = await axios.get(variantUrl.includes('/') ? variantUrl : `${baseURL}/${variantUrl}`).then((r) => r.data);
    } else {
      baseURL = variantUrl.substring(0, variantUrl.lastIndexOf('/'));
      variantM3u8String = await axios.get(variantUrl).then((r) => r.data);
    }

    const parsedPlaylist: any = HLS.parse(variantM3u8String);

    if (!parsedPlaylist || !parsedPlaylist.segments?.length) {
      console.error(`No segments found in Twitch playlist for ${vodId}`);
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
    console.error(`Failed to get Twitch HLS duration:`, error instanceof Error ? error.message : error);
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
