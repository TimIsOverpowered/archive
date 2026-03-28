import { google } from 'googleapis';
import fs from 'fs';
import fsPromises from 'fs/promises';
import { getStreamerConfig } from '../config/loader.js';
import { decryptObject } from '../utils/encryption.js';

interface AuthObject {
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  expires_in: number;
}

interface DecryptedYoutubeCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

const authCache = new Map<string, AuthObject>();
const decryptedAuthCache = new Map<string, DecryptedYoutubeCreds>();

function getYoutubeCredentials(streamerId: string): DecryptedYoutubeCreds | null {
  const config = getStreamerConfig(streamerId);

  if (!config?.youtube?.auth) {
    return null;
  }

  // Check cache first
  const cached = decryptedAuthCache.get(streamerId);
  if (cached) {
    return cached;
  }

  try {
    const authObj = decryptObject<{ client_id: string; client_secret: string; refresh_token: string }>(config.youtube.auth);

    // Store in cache - will update after token refresh
    const creds: DecryptedYoutubeCreds = {
      clientId: authObj.client_id,
      clientSecret: authObj.client_secret,
      refreshToken: authObj.refresh_token,
    };

    decryptedAuthCache.set(streamerId, creds);
    return creds;
  } catch (error) {
    console.error(`Failed to decrypt YouTube credentials for ${streamerId}:`, error);
    return null;
  }
}

function updateYoutubeRefreshToken(streamerId: string, newAuthTokenObject: AuthObject): void {
  const config = getStreamerConfig(streamerId);

  if (!config?.youtube?.auth) {
    console.warn(`No YouTube auth configured for ${streamerId}, cannot update refresh token`);
    return;
  }

  try {
    // Update the in-memory cache
    decryptedAuthCache.set(streamerId, {
      clientId: config.youtube.apiKey || '', // apiKey is reused as client_id from original decrypt
      clientSecret: '', // Will be re-decrypte d if needed
      refreshToken: newAuthTokenObject.refresh_token,
    });

    // Re-read and update with the new refresh token
    const authObj = decryptObject<{ client_id: string; client_secret: string; refresh_token: string }>(config.youtube.auth);

    authObj.refresh_token = newAuthTokenObject.refresh_token;

    // Encrypt back to config (in-memory only, doesn't persist to DB)
    decryptedAuthCache.set(streamerId, {
      clientId: authObj.client_id,
      clientSecret: authObj.client_secret,
      refreshToken: authObj.refresh_token,
    });
  } catch (error) {
    console.error(`Failed to update YouTube refresh token for ${streamerId}:`, error);
  }
}

export async function getAccessToken(streamerId: string): Promise<string> {
  const creds = getYoutubeCredentials(streamerId);

  if (!creds) {
    throw new Error('YouTube credentials not configured');
  }

  const cached = authCache.get(streamerId);
  if (cached && cached.access_token) {
    const expiresAt = Date.now() + cached.expires_in * 1000;
    if (expiresAt > Date.now()) {
      return cached.access_token;
    }
  }

  const oauth2Client = new google.auth.OAuth2(creds.clientId, creds.clientSecret, 'https://developers.google.com/oauthplayground');

  oauth2Client.setCredentials({
    refresh_token: creds.refreshToken,
  });

  const credentials = await oauth2Client.refreshAccessToken();

  if (credentials.credentials.access_token) {
    const authObj: AuthObject = {
      access_token: credentials.credentials.access_token!,
      refresh_token: credentials.credentials.refresh_token || creds.refreshToken,
      scope: credentials.credentials.scope || '',
      token_type: credentials.credentials.token_type || 'Bearer',
      expires_in: credentials.credentials.expiry_date ? Math.floor(((credentials.credentials.expiry_date as number) - Date.now()) / 1000) : 3600,
    };

    authCache.set(streamerId, authObj);

    // Update the refresh token in decrypted cache if it changed
    if (credentials.credentials.refresh_token && credentials.credentials.refresh_token !== creds.refreshToken) {
      updateYoutubeRefreshToken(streamerId, authObj);
    }

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
  const creds = getYoutubeCredentials(streamerId);

  if (!creds) {
    throw new Error('YouTube credentials not configured');
  }

  const oauth2Client = new google.auth.OAuth2(creds.clientId, creds.clientSecret, 'https://developers.google.com/oauthplayground');

  oauth2Client.setCredentials({
    refresh_token: creds.refreshToken,
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
  const creds = getYoutubeCredentials(streamerId);

  if (!creds) {
    throw new Error('YouTube credentials not configured');
  }

  const oauth2Client = new google.auth.OAuth2(creds.clientId, creds.clientSecret, 'https://developers.google.com/oauthplayground');

  oauth2Client.setCredentials({
    refresh_token: creds.refreshToken,
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
  const creds = getYoutubeCredentials(streamerId);

  if (!creds) {
    throw new Error('YouTube credentials not configured');
  }

  const oauth2Client = new google.auth.OAuth2(creds.clientId, creds.clientSecret, 'https://developers.google.com/oauthplayground');

  oauth2Client.setCredentials({
    refresh_token: creds.refreshToken,
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
