import axios from 'axios';
import { getTwitchCredentials as getCreds } from '../utils/credentials.js';

interface VodData {
  id: string;
  user_id: string;
  user_login: string;
  title: string;
  duration: string;
  started_at: string;
  published_at: string;
  thumbnail_url: string;
  viewable: string;
  language: string;
  type: string;
  views: number;
  game_id?: string;
}

interface VodTokenSig {
  value: string;
  signature: string;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function getAppAccessToken(streamerId: string): Promise<string> {
  const creds = getCreds(streamerId);

  if (!creds) {
    throw new Error('Twitch credentials not configured');
  }

  const cached = tokenCache.get(streamerId);
  if (cached && cached.expiresAt > Date.now() + 24 * 60 * 60 * 1000) {
    return cached.token;
  }

  const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
    params: {
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: 'client_credentials',
    },
  });

  const { access_token, expires_in } = response.data;
  tokenCache.set(streamerId, {
    token: access_token,
    expiresAt: Date.now() + expires_in * 1000,
  });

  return access_token;
}

export async function getVodData(vodId: string, streamerId: string): Promise<VodData> {
  const accessToken = await getAppAccessToken(streamerId);
  const creds = getCreds(streamerId)!;

  const response = await axios.get('https://api.twitch.tv/helix/videos', {
    params: { id: vodId },
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Client-Id': creds.clientId,
    },
  });

  if (!response.data.data || response.data.data.length === 0) {
    throw new Error(`VOD ${vodId} not found`);
  }

  return response.data.data[0];
}

export async function getVodTokenSig(vodId: string): Promise<VodTokenSig> {
  const response = await axios.post(
    'https://gql.twitch.tv/gql',
    {
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
    },
    {
      headers: {
        Accept: '*/*',
        'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
        'Content-Type': 'text/plain;charset=UTF-8',
      },
    }
  );

  const token = response.data.data.videoPlaybackAccessToken;
  if (!token) {
    throw new Error('Failed to get VOD token');
  }

  return {
    value: token.value,
    signature: token.signature,
  };
}

export async function getM3u8(vodId: string, token: string, sig: string): Promise<string> {
  const response = await axios.get(
    `https://usher.ttvnw.net/vod/${vodId}.m3u8?allow_source=true&player=mediaplayer&include_unavailable=true&supported_codecs=av1,h265,h264&playlist_include_framerate=true&allow_spectre=true&nauthsig=${sig}&nauth=${token}`
  );

  return response.data;
}

export async function fetchComments(vodId: string, offset = 0): Promise<any | null> {
  const response = await axios.post(
    'https://gql.twitch.tv/gql',
    {
      operationName: 'VideoCommentsByOffsetOrCursor',
      variables: {
        videoID: vodId,
        contentOffsetSeconds: offset,
      },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: 'b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a',
        },
      },
    },
    {
      headers: {
        Accept: '*/*',
        'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
        'Content-Type': 'text/plain;charset=UTF-8',
      },
    }
  );

  return response.data.data?.video || null;
}

export async function fetchNextComments(vodId: string, cursor: string): Promise<any | null> {
  const response = await axios.post(
    'https://gql.twitch.tv/gql',
    {
      operationName: 'VideoCommentsByOffsetOrCursor',
      variables: {
        videoID: vodId,
        cursor: cursor,
      },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: 'b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a',
        },
      },
    },
    {
      headers: {
        Accept: '*/*',
        'Client-Id': 'kd1unb4b3q4t58fwlpcbzcbnm76a8fp',
        'Content-Type': 'text/plain;charset=UTF-8',
      },
    }
  );

  return response.data.data?.video || null;
}

export async function getChapters(vodId: string): Promise<any | null> {
  const response = await axios.post(
    'https://gql.twitch.tv/gql',
    {
      operationName: 'VideoPreviewCard__VideoMoments',
      variables: {
        videoId: vodId,
      },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: '7399051b2d46f528d5f0eedf8b0db8d485bb1bb4c0a2c6707be6f1290cdcb31a',
        },
      },
    },
    {
      headers: {
        Accept: '*/*',
        'Client-Id': 'kd1unb4b3q4t58fwlpcbzcbnm76a8fp',
        'Content-Type': 'text/plain;charset=UTF-8',
      },
    }
  );

  return response.data?.data || null;
}

export async function getChapter(vodId: string): Promise<any | null> {
  const response = await axios.post(
    'https://gql.twitch.tv/gql',
    {
      operationName: 'NielsenContentMetadata',
      variables: {
        isCollectionContent: false,
        isLiveContent: false,
        isVODContent: true,
        collectionID: '',
        login: '',
        vodID: vodId,
      },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: '2dbf505ee929438369e68e72319d1106bb3c142e295332fac157c90638968586',
        },
      },
    },
    {
      headers: {
        Accept: '*/*',
        'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
        'Content-Type': 'text/plain;charset=UTF-8',
      },
    }
  );

  return response.data.data?.video || null;
}

export async function getGameData(gameId: string, streamerId: string): Promise<any | null> {
  const accessToken = await getAppAccessToken(streamerId);

  const creds = getCreds(streamerId)!;

  const response = await axios.get('https://api.twitch.tv/helix/games', {
    params: { id: gameId },
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Client-Id': creds.clientId,
    },
  });

  if (!response.data.data || response.data.data.length === 0) {
    return null;
  }

  return response.data.data[0];
}
