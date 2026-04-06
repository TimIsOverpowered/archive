import { google, Auth } from 'googleapis';
import fs from 'fs';
import { getTenantConfig, configCache } from '../config/loader.js';
import { decryptObject, encryptObject } from '../utils/encryption.js';
import { metaClient } from '../db/meta-client.js';
import { extractErrorDetails } from '../utils/error.js';
import { sleep } from '../utils/delay.js';
import { logger as baseLogger } from '../utils/logger.js';
import { createAutoLogger as loggerWithTenant } from '../utils/auto-tenant-logger.js';
import { Prisma } from '../../prisma/generated/meta/client.js';

export interface UploadProgressCallbackData {
  milestone: 'starting' | 'processing_metadata' | 'success' | 'error';
  videoId?: string;
  thumbnailUrl?: string;
  errorDetails?: Error;
}

export type YoutubeUploadProgress = (data: UploadProgressCallbackData) => void | Promise<void>;

interface AuthObject {
  access_token?: string; // Optional - may not exist if expired and not refreshed yet
  refresh_token: string; // Always required for persistence
  expiry_date: number; // Absolute timestamp (Option A per user choice)
  scope?: string; // Preserve from OAuth grant
  token_type?: string; // Usually "Bearer" - preserve but optional
}

interface DecryptedYoutubeCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string; // Optional cached short-lived token if still valid
}

// Define structure of youtube JSONB field for type safety
export interface YoutubeJson extends Prisma.JsonObject {
  // Encrypted string containing the AuthObject (access_token, refresh_token, etc.)
  auth: string;

  // Metadata and Settings from your sample
  description: string;
  public: boolean;
  vodUpload: boolean;
  perGameUpload: boolean;
  restrictedGames: string[];
  splitDuration: number;
  liveUpload: boolean;
  multiTrack: boolean;
  upload: boolean;

  // Optional/Legacy fields
  apiKey?: string;
}

// Global redirect URI for Google OAuth flow (Google playground)
const REDIRECT_URI = 'https://developers.google.com/oauthplayground';

/**
 * Fast local expiry check without network call.
 * Returns true if token is expired or will expire within next minute (clock skew buffer).
 */
function isTokenExpired(client: Auth.OAuth2Client): boolean {
  const expiry = client.credentials.expiry_date as number | undefined;

  // No expiry set means no valid access token cached - assume needs refresh
  if (!expiry) return true;

  const now = Date.now();

  // Return true if expired OR expiring within next 60 seconds (buffer for clock skew/network latency)
  return now >= expiry - 60_000;
}

/**
 * Get valid YouTube access token, refreshing if expired.
 * Uses 60-second buffer for clock skew.
 */
async function getValidYoutubeToken(tenantId: string): Promise<string> {
  const log = loggerWithTenant(tenantId);
  const creds = getYoutubeCredentials(tenantId);
  if (!creds) {
    throw new Error(`YouTube credentials not configured for ${tenantId}`);
  }

  const config = getTenantConfig(tenantId);
  if (!config?.youtube?.auth) {
    throw new Error(`YouTube auth not configured for ${tenantId}`);
  }

  // Check if cached access token is still valid (with 60-second buffer)
  if (creds.accessToken) {
    try {
      const authObj = decryptObject<AuthObject>(config.youtube.auth);
      const expiryDate = authObj.expiry_date;

      if (expiryDate && expiryDate > Date.now() + 60_000) {
        return creds.accessToken;
      }
    } catch {
      // Ignore - will refresh below
    }
  }

  // Token expired or missing - refresh it
  log.info({ tenantId }, 'YouTube token expired or missing, refreshing');

  const oauth2Client = new google.auth.OAuth2(creds.clientId, creds.clientSecret, REDIRECT_URI);
  oauth2Client.setCredentials({
    refresh_token: creds.refreshToken,
    access_token: creds.accessToken || null,
  });

  try {
    const { credentials } = await oauth2Client.refreshAccessToken();

    if (!credentials.access_token || !credentials.expiry_date) {
      throw new Error('Token refresh failed - no access token or expiry returned');
    }

    // Update DB with new token (fire-and-forget)
    if (credentials.refresh_token) {
      updateYoutubeTokenInDb(tenantId, credentials.access_token, credentials.expiry_date, credentials.refresh_token).catch((err) => {
        const { message } = extractErrorDetails(err);
        log.warn({ tenantId, error: message }, 'Failed to update YouTube token in database');
      });
    }

    log.info({ tenantId, expiry_date: credentials.expiry_date }, 'YouTube token refreshed');

    return credentials.access_token;
  } catch (error: unknown) {
    const details = extractErrorDetails(error);

    if (details.message.includes('invalid_grant') || details.message.includes('token_expired')) {
      throw new Error(`YouTube token refresh failed for ${tenantId} - re-authentication required. Original error: ${details.message}`);
    }

    throw error;
  }
}

/**
 * Update YouTube token in database and config cache (fire-and-forget).
 */
async function updateYoutubeTokenInDb(tenantId: string, newAccessToken: string, newExpiryDate: number, refreshToken: string): Promise<void> {
  const log = loggerWithTenant(tenantId);
  const config = getTenantConfig(tenantId);
  if (!config?.youtube?.auth) {
    return;
  }

  try {
    const updatedAuth: AuthObject = {
      access_token: newAccessToken,
      refresh_token: refreshToken,
      expiry_date: newExpiryDate,
    };

    const encryptedAuth = encryptObject(updatedAuth);

    await metaClient.tenant.update({
      where: { id: tenantId },
      data: {
        youtube: {
          ...config.youtube,
          auth: encryptedAuth,
        },
      },
    });

    // Update specific tenant's config in cache (like Twitch)
    configCache.set(tenantId, {
      ...config,
      youtube: {
        ...config.youtube,
        auth: encryptedAuth,
      },
    });

    log.info({ tenantId }, 'Updated YouTube token in database');
  } catch (err) {
    const { message } = extractErrorDetails(err);
    log.warn({ tenantId, error: message }, 'Failed to update YouTube token in database');
  }
}

function getYoutubeCredentials(tenantId: string): DecryptedYoutubeCreds | null {
  // Global OAuth2 app credentials from .env (single source of truth for all tenants)
  const log = loggerWithTenant(tenantId);
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    log.error('[YouTube] YOUTUBE_CLIENT_ID or YOUTUBE_CLIENT_SECRET not set in .env');
    return null;
  }

  // Per-tenant refresh token from encrypted DB field (only this is tenant-specific)
  const config = getTenantConfig(tenantId);

  if (!config?.youtube?.auth) {
    log.warn(`[YouTube] No auth configured`);
    return null;
  }

  try {
    // Decrypt complete auth object (now includes access_token + expiry_date from our persistence logic)
    const authObj = decryptObject<AuthObject>(config.youtube.auth);

    if (!authObj.refresh_token || typeof authObj.refresh_token !== 'string' || !authObj.refresh_token.trim()) {
      log.warn(`[YouTube] No valid refresh token found`);
      return null;
    }

    // Build base credentials object with required fields only (refreshToken is mandatory)
    const creds: DecryptedYoutubeCreds = {
      clientId, // From global .env - same for all tenants using shared OAuth app
      clientSecret, // From global .env - same for all tenants
      refreshToken: authObj.refresh_token.trim(), // Per-tenant unique value from DB (required)
    };

    // Include optional access token only if present AND still valid based on expiry_date check
    if (authObj.access_token && typeof authObj.expiry_date === 'number') {
      const now = Date.now();

      // Check if cached token is still valid for more than 1 minute (buffer for clock skew)
      if (now < authObj.expiry_date - 60_000) {
        creds.accessToken = authObj.access_token;

        log.info(`[YouTube] Using cached access token, expires at ${new Date(authObj.expiry_date).toISOString()}`);
      } else {
        // Token exists but expired or expiring soon - will force refresh on next API call (correct behavior)
        const timeUntilExpiry = authObj.expiry_date - now;

        if (timeUntilExpiry < 0) {
          log.info(`[YouTube] Cached access token expired ${Math.abs(timeUntilExpiry / 1000).toFixed(0)}s ago, will refresh on next API call`);
        } else {
          log.info(`[YouTube] Access token expiring in ${(timeUntilExpiry / 1000).toFixed(0)}s (<60s buffer), forcing refresh for safety`);
        }
      }
    } else if (authObj.access_token) {
      // Has access_token but no expiry_date - suspicious data state, skip using cached token
      log.warn(`[YouTube] Cached access token has no valid expiry_date field, skipping cache use`);
    }

    return creds;
  } catch (error: unknown) {
    const details = extractErrorDetails(error);

    log.error(details, `Failed to decrypt YouTube credentials for ${tenantId}`);
    return null; // Return null instead of throwing - let caller handle gracefully
  }
}

/**
 * Validate YouTube token without forcing refresh.
 * Checks if token is still valid based on expiry_date.
 */
export async function validateYoutubeToken(tenantId: string): Promise<boolean> {
  const creds = getYoutubeCredentials(tenantId);
  if (!creds || !creds.accessToken) return false;

  const config = getTenantConfig(tenantId);
  if (!config?.youtube?.auth) return false;

  try {
    const authObj = decryptObject<AuthObject>(config.youtube.auth);
    const expiryDate = authObj.expiry_date;

    // Check if token is still valid (with 60-second buffer)
    if (expiryDate && expiryDate > Date.now() + 60_000) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Clear OAuth client cache for debugging/credential rotation.
 */
export async function uploadVideo(
  tenantId: string,
  displayName: string,
  filePath: string,
  title: string,
  description: string,
  privacyStatus: 'public' | 'unlisted' | 'private',
  onProgress?: YoutubeUploadProgress
): Promise<{ videoId: string; thumbnailUrl: string }> {
  const log = loggerWithTenant(tenantId);

  // Milestone 1: Starting - notify progress callback if provided (worker handles Discord)
  if (onProgress) {
    await onProgress({ milestone: 'starting' });
  }

  try {
    const creds = getYoutubeCredentials(tenantId);
    if (!creds) {
      throw new Error('YouTube credentials not configured');
    }
    const accessToken = await getValidYoutubeToken(tenantId);
    const oauth2Client = new google.auth.OAuth2(creds.clientId, creds.clientSecret, REDIRECT_URI);
    oauth2Client.setCredentials({ access_token: accessToken });
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

    log.info(`[YouTube] Starting upload for ${displayName}: ${title}`);

    const response = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: { title, description },
        status: { privacyStatus },
      },
      media: { body: fs.createReadStream(filePath) }, // Stream-based upload handles large files efficiently with built-in retry logic
    });

    const videoId = response.data?.id;
    if (!videoId) throw new Error('Upload completed but no video ID returned');

    // Milestone 2: Processing metadata - notify progress callback (worker updates Discord)
    if (onProgress) {
      await onProgress({ milestone: 'processing_metadata', videoId });
    }

    // Wait for YouTube to generate thumbnails before fetching
    await sleep(3000);

    let thumbnailUrl = '';
    const meta = await youtube.videos.list({ part: ['snippet'], id: [videoId] });
    const thumbs = meta.data?.items?.[0]?.snippet?.thumbnails;
    thumbnailUrl = thumbs?.high?.url || thumbs?.medium?.url || '';

    // Milestone 3: Success with metadata - worker sends final Discord embed with auto-expandable thumbnail
    if (onProgress) {
      await onProgress({ milestone: 'success', videoId, thumbnailUrl });
    }

    return { videoId, thumbnailUrl };
  } catch (err) {
    const details = extractErrorDetails(err);
    log.error(details, `[YouTube] Upload failed for ${displayName}`);

    // Milestone 4: Error - worker sends failure Discord embed with error message
    if (onProgress) {
      await onProgress({ milestone: 'error', errorDetails: err as Error });
    }

    throw err; // Re-throw for upstream retry handling in worker
  }
}

export async function addChapters(tenantId: string, videoId: string, chapters: { time: string; title: string }[]): Promise<void> {
  const creds = getYoutubeCredentials(tenantId);
  if (!creds) {
    throw new Error('YouTube credentials not configured');
  }
  const accessToken = await getValidYoutubeToken(tenantId);
  const oauth2Client = new google.auth.OAuth2(creds.clientId, creds.clientSecret, REDIRECT_URI);
  oauth2Client.setCredentials({ access_token: accessToken });
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

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

export async function linkParts(tenantId: string, videoIds: { id: string; part: number }[]): Promise<void> {
  const creds = getYoutubeCredentials(tenantId);
  if (!creds) {
    throw new Error('YouTube credentials not configured');
  }
  const accessToken = await getValidYoutubeToken(tenantId);
  const oauth2Client = new google.auth.OAuth2(creds.clientId, creds.clientSecret, REDIRECT_URI);
  oauth2Client.setCredentials({ access_token: accessToken });
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

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
