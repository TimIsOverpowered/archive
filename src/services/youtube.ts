import { google } from 'googleapis';
import fs from 'fs';
import fsPromises from 'fs/promises';
import { getStreamerConfig } from '../config/loader';

interface AuthObject {
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  expires_in: number;
}

const authCache = new Map<string, AuthObject>();

export async function getAccessToken(streamerId: string): Promise<string> {
  const config = getStreamerConfig(streamerId);
  if (!config?.youtube?.refreshToken || !config.youtube.clientId || !config.youtube.clientSecret) {
    throw new Error('YouTube credentials not configured');
  }

  const cached = authCache.get(streamerId);
  if (cached && cached.access_token) {
    const expiresAt = Date.now() + cached.expires_in * 1000;
    if (expiresAt > Date.now()) {
      return cached.access_token;
    }
  }

  const oauth2Client = new google.auth.OAuth2(config.youtube.clientId, config.youtube.clientSecret, 'https://developers.google.com/oauthplayground');

  oauth2Client.setCredentials({
    refresh_token: config.youtube.refreshToken,
  });

  const credentials = await oauth2Client.refreshAccessToken();

  if (credentials.credentials.access_token) {
    authCache.set(streamerId, {
      access_token: credentials.credentials.access_token!,
      refresh_token: credentials.credentials.refresh_token || config.youtube.refreshToken,
      scope: credentials.credentials.scope || '',
      token_type: credentials.credentials.token_type || 'Bearer',
      expires_in: credentials.credentials.expiry_date ? Math.floor(((credentials.credentials.expiry_date as number) - Date.now()) / 1000) : 3600,
    });

    return credentials.credentials.access_token;
  }

  throw new Error('Failed to get YouTube access token');
}

export async function uploadVideo(
  streamerId: string,
  filePath: string,
  title: string,
  description: string,
  privacyStatus: 'public' | 'unlisted' | 'private'
): Promise<{ videoId: string; thumbnailUrl: string }> {
  const config = getStreamerConfig(streamerId);

  if (!config?.youtube?.clientId || !config.youtube.clientSecret || !config.youtube.refreshToken) {
    throw new Error('YouTube credentials not configured');
  }

  const oauth2Client = new google.auth.OAuth2(config.youtube.clientId, config.youtube.clientSecret, 'https://developers.google.com/oauthplayground');

  oauth2Client.setCredentials({
    refresh_token: config.youtube.refreshToken,
  });

  const youtube = google.youtube({
    version: 'v3',
    auth: oauth2Client,
  });

  await fsPromises.stat(filePath);

  const response = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title,
        description,
      },
      status: {
        privacyStatus,
      },
    },
    media: {
      body: fs.createReadStream(filePath),
    },
  });

  if (!response.data?.id) {
    throw new Error('Video upload failed - no video ID returned');
  }

  const videoId = response.data.id;

  let thumbnailUrl = '';
  try {
    const thumbnailsResponse = await youtube.videos.list({
      part: ['snippet'],
      id: [videoId],
    });

    if (thumbnailsResponse.data?.items && thumbnailsResponse.data.items.length > 0) {
      const thumbnails = thumbnailsResponse.data.items[0]?.snippet?.thumbnails;
      thumbnailUrl = thumbnails?.high?.url || thumbnails?.medium?.url || '';
    }
  } catch (err) {
    console.error('Failed to fetch thumbnail URL:', err);
  }

  return { videoId, thumbnailUrl };
}

export async function addChapters(streamerId: string, videoId: string, chapters: { time: string; title: string }[]): Promise<void> {
  const config = getStreamerConfig(streamerId);
  if (!config?.youtube?.clientId || !config.youtube.clientSecret || !config.youtube.refreshToken) {
    throw new Error('YouTube credentials not configured');
  }

  const oauth2Client = new google.auth.OAuth2(config.youtube.clientId, config.youtube.clientSecret, 'https://developers.google.com/oauthplayground');

  oauth2Client.setCredentials({
    refresh_token: config.youtube.refreshToken,
  });

  const youtube = google.youtube({
    version: 'v3',
    auth: oauth2Client,
  });

  const currentVideo = await youtube.videos.list({
    part: ['snippet'],
    id: [videoId],
  });

  const currentDescription = currentVideo.data?.items?.[0]?.snippet?.description || '';
  const chapterTimestamps = chapters.map((c) => `${c.time} ${c.title}`).join('\n');

  let newDescription = currentDescription;
  if (!newDescription.includes(chapterTimestamps)) {
    newDescription = currentDescription ? `${currentDescription}\n\n${chapterTimestamps}` : chapterTimestamps;
  }

  await youtube.videos.update({
    part: ['snippet'],
    requestBody: {
      id: videoId,
      snippet: {
        description: newDescription,
      },
    },
  });
}

export async function linkParts(streamerId: string, videoIds: { id: string; part: number }[]): Promise<void> {
  const config = getStreamerConfig(streamerId);
  if (!config?.youtube?.clientId || !config.youtube.clientSecret || !config.youtube.refreshToken) {
    throw new Error('YouTube credentials not configured');
  }

  const oauth2Client = new google.auth.OAuth2(config.youtube.clientId, config.youtube.clientSecret, 'https://developers.google.com/oauthplayground');

  oauth2Client.setCredentials({
    refresh_token: config.youtube.refreshToken,
  });

  const youtube = google.youtube({
    version: 'v3',
    auth: oauth2Client,
  });

  const sortedParts = [...videoIds].sort((a, b) => a.part - b.part);

  for (let i = 0; i < sortedParts.length; i++) {
    const { id: videoId } = sortedParts[i];

    const currentVideo = await youtube.videos.list({
      id: [videoId],
    });

    const currentDescription = currentVideo.data?.items?.[0]?.snippet?.description || '';

    const nextPart = sortedParts[i + 1];
    const linkText = nextPart ? `Next: EP ${nextPart.part} (${nextPart.id})` : 'End of series';

    let newDescription = currentDescription;
    if (!newDescription.includes(linkText)) {
      newDescription = currentDescription ? `${currentDescription}\n\n${linkText}` : linkText;
    }

    await youtube.videos.update({
      part: ['snippet'],
      requestBody: {
        id: videoId,
        snippet: {
          description: newDescription,
        },
      },
    });
  }
}
