import HLS from 'hls-parser';
import { Kick } from '../../constants.js';
import { createSession } from '../../utils/cycletls.js';
import { VodNotFoundError } from '../../utils/domain-errors.js';
import { extractErrorDetails } from '../../utils/error.js';
import { fetchUrl } from '../../utils/flaresolverr-client.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger({ module: 'kick-vod' });

export interface KickVod {
  id: number;
  slug: string | null;
  channel_id: number;
  created_at: string;
  session_title: string | null;
  is_live: boolean;
  risk_level_id: number | null;
  start_time: string | null;
  source: string | null;
  twitch_channel: string | null;
  duration: number;
  language: string | null;
  is_mature: boolean;
  viewer_count: number | null;
  tags: string[] | null;
  thumbnail: {
    src: string | null;
    srcset: string | null;
  } | null;
  views: number | null;
  video: {
    id: number;
    live_stream_id: number;
    slug: string | null;
    thumb: string | null;
    s3: string | null;
    trading_platform_id: number | null;
    created_at: string;
    updated_at: string;
    uuid: string;
    views: number;
    deleted_at: string | null;
    is_pruned: boolean;
    is_private: boolean;
    status: string;
  } | null;
  categories: Array<{
    id: number;
    category_id: number;
    name: string;
    slug: string;
    tags: string[];
    description: string | null;
    deleted_at: string | null;
    is_mature: boolean;
    is_promoted: boolean;
    viewers: number;
    is_fallback: boolean;
    banner: {
      responsive: string | null;
      url: string | null;
    } | null;
  }> | null;
}

function getKickParsedM3u8(m3u8: string, baseURL: string): string | null {
  try {
    const parsed = HLS.parse(m3u8);

    if (!('variants' in parsed) || parsed.variants.length === 0) {
      return null;
    }

    const bestVariant = parsed.variants[0];
    if (bestVariant == null) return null;

    if (bestVariant.uri == null || bestVariant.uri === '') {
      return null;
    }

    return `${baseURL}/${bestVariant.uri}`;
  } catch (error) {
    const details = extractErrorDetails(error);
    log.debug({ details }, 'Failed to parse HLS master playlist');
    return null;
  }
}

export async function getVod(channelName: string, vodId: string): Promise<KickVod> {
  const result = await fetchUrl<KickVod[]>(`${Kick.API_BASE}/api/v2/channels/${channelName}/videos`);

  if (!result.success) {
    throw new Error('Failed to load Kick videos API after retries');
  }

  const dataArray = result.data;

  if (!Array.isArray(dataArray)) {
    throw new VodNotFoundError(vodId, 'kick api response');
  }

  const video = dataArray.find((v): v is KickVod => {
    if (typeof v !== 'object') return false;
    return v.id === Number(vodId);
  });

  if (video == null) {
    throw new VodNotFoundError(vodId, 'kick api');
  }

  return video;
}

export async function getKickParsedM3u8ForFfmpeg(sourceUrl: string): Promise<string | null> {
  const session = createSession();

  try {
    const m3u8Content = await session.fetchText(sourceUrl);

    if (m3u8Content == null || m3u8Content === '') {
      throw new Error('Empty HLS playlist response from Kick');
    }

    let m3u8Url: string | null;

    if (sourceUrl.includes('master.m3u8')) {
      const baseURL = sourceUrl.replace('/master.m3u8', '');
      m3u8Url = getKickParsedM3u8(m3u8Content, baseURL);

      if (m3u8Url == null || m3u8Url === '') {
        throw new Error('No video variants found in HLS playlist');
      }
    } else {
      m3u8Url = sourceUrl;
    }

    return m3u8Url;
  } finally {
    session.close();
  }
}
