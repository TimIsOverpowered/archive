import { Twitch } from '../../constants.js';
import { VodNotFoundError } from '../../utils/domain-errors.js';
import { request } from '../../utils/http-client.js';
import { retryWithBackoff } from '../../utils/retry.js';
import { getTwitchClient } from './auth.js';
import { createTwitchGqlClient } from './client.js';

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

export async function getVodData(vodId: string, logContext?: Record<string, unknown>): Promise<VodData> {
  const client = getTwitchClient();
  const data = await client.helix.get<{ data: VodData[] }>(`/videos?id=${vodId}`, logContext);

  if (data.data == null || data.data.length === 0) {
    throw new VodNotFoundError(vodId, 'twitch helix');
  }
  return data.data[0] as VodData;
}

export async function getVodTokenSig(
  vodId: string,
  tenantId?: string,
  retryOptions?: { attempts?: number; baseDelayMs?: number; maxDelayMs?: number }
): Promise<VodTokenSig> {
  const client = createTwitchGqlClient(tenantId);
  const attempts = retryOptions?.attempts ?? 3;
  const baseDelayMs = retryOptions?.baseDelayMs ?? 1000;
  const maxDelayMs = retryOptions?.maxDelayMs ?? 10000;

  const data = await retryWithBackoff(
    async () =>
      client.post<{ data: { videoPlaybackAccessToken: VodTokenSig } }>({
        operationName: 'PlaybackAccessToken',
        variables: {
          isLive: false,
          isVod: true,
          login: '',
          platform: 'web',
          playerType: 'site',
          vodID: vodId,
        },
        extensions: {
          persistedQueries: {
            version: 1,
            sha256Hash: 'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9',
          },
        },
      }),
    { attempts, baseDelayMs, maxDelayMs }
  );

  const token = data.data.videoPlaybackAccessToken;
  if (token == null) {
    throw new Error('Failed to get VOD token');
  }
  return {
    value: token.value,
    signature: token.signature,
  };
}

export async function getM3u8(
  vodId: string,
  token: string,
  sig: string,
  retryOptions?: {
    attempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    shouldRetry?: (error: unknown) => boolean;
  }
): Promise<string> {
  const codecs = encodeURIComponent('av1,h265,h264');
  const url = `${Twitch.USHER_BASE_URL}/${vodId}.m3u8?allow_source=true&player=mediaplayer&include_unavailable=true&supported_codecs=${codecs}&playlist_include_framerate=true&allow_spectre=true&nauthsig=${sig}&nauth=${token}`;

  return request(url, {
    responseType: 'text',
    timeoutMs: 30000,
    retryOptions,
  });
}
