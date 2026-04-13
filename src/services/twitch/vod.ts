import { createTwitchClient } from './client.js';
import { getAppAccessToken } from './auth.js';

export interface VodData {
  id: string;
  stream_id?: string | null;
  user_id: string;
  user_login: string;
  user_name: string;
  title: string;
  description?: string | null;
  created_at: string;
  published_at: string;
  url?: string | null;
  thumbnail_url: string;
  viewable: string;
  language: string;
  type: string;
  duration: string;
  view_count: number;
  muted_segments?: Array<{ duration: number; offset: number }> | null;
}

interface VodTokenSig {
  value: string;
  signature: string;
}

function getTwitchClient(tenantId: string) {
  return createTwitchClient(tenantId, () => getAppAccessToken(tenantId));
}

export async function getVodData(vodId: string, tenantId: string): Promise<VodData> {
  const client = getTwitchClient(tenantId);
  const data = await client.helix.get<{ data: VodData[] }>(`/videos?id=${vodId}`);

  if (!data.data || data.data.length === 0) {
    throw new Error(`VOD ${vodId} not found`);
  }
  return data.data[0] as VodData;
}

export async function getVodTokenSig(vodId: string): Promise<VodTokenSig> {
  const client = getTwitchClient('gql-placeholder');

  const data = await client.gql.post<{ data: { videoPlaybackAccessToken: VodTokenSig } }>({
    operationName: 'PlaybackAccessToken',
    variables: {
      isLive: false,
      login: '',
      isVod: true,
      vodID: vodId,
      platform: 'web',
      playerBackend: 'mediaplayer',
      playerType: 'site',
    },
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: '0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712',
      },
    },
  });

  const token = data.data.videoPlaybackAccessToken;
  if (!token) {
    throw new Error('Failed to get VOD token');
  }
  return {
    value: token.value,
    signature: token.signature,
  };
}

export async function getM3u8(vodId: string, token: string, sig: string): Promise<string> {
  const url = `https://usher.ttvnw.net/vod/${vodId}.m3u8?allow_source=true&player=mediaplayer&include_unavailable=true&supported_codecs=av1,h265,h264&playlist_include_framerate=true&allow_spectre=true&nauthsig=${sig}&nauth=${token}`;

  const { request } = await import('../../utils/http-client.js');
  return request(url, {
    responseType: 'text',
    timeoutMs: 30000,
  });
}
