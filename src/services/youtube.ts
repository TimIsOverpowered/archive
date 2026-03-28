import { google } from 'googleapis';
import fs from 'fs';
import fsPromises from 'fs/promises';
import { getStreamerConfig, clearConfigCache } from '../config/loader.js';
import { decryptObject, encryptObject } from '../utils/encryption.js';
import { metaClient } from '../db/meta-client.js';

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

// Global redirect URI for Google OAuth flow (Google playground)
const REDIRECT_URI = 'https://developers.google.com/oauthplayground';

// Per-tenant cached OAuth2 clients (long-lived across API calls, enables auto-refresh)
const oauthClients = new Map<any, any>();

// Cache for backward compatibility - will be less used with new pattern
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const authCache = new Map<string, AuthObject>();
const decryptedAuthCache = new Map<string, DecryptedYoutubeCreds>();

/**
 * Fast local expiry check without network call.
 * Returns true if token is expired or will expire within next minute (clock skew buffer).
 */
function isTokenExpired(client: any): boolean {
  const expiry = client.credentials.expiry_date as number | undefined;

  // No expiry set means no valid access token cached - assume needs refresh
  if (!expiry) return true;

  const now = Date.now();

  // Return true if expired OR expiring within next 60 seconds (buffer for clock skew/network latency)
  return now >= expiry - 60_000;
}

/**
 * Get or create cached OAuth2 client for tenant with auto-refresh persistence.
 * Implements Option 3 pattern from Google docs - on('tokens') listener handles automatic token management.
 */
function getYoutubeOAuthClient(streamerId: string): any {
  const creds = getYoutubeCredentials(streamerId);

  if (!creds) {
    throw new Error(`YouTube credentials not configured for tenant ${streamerId}`);
  }

  // Fast path - return cached client if exists and token still valid (local expiry check, Option 2)
  const client = oauthClients.get(streamerId);

  if (client && !isTokenExpired(client)) {
    return client;
  }

  // Create fresh OAuth2 client with auto-refresh listener for persistence (Option B - robust DB sync)
  const newClient = new google.auth.OAuth2(creds.clientId, creds.clientSecret, REDIRECT_URI);

  // Auto-persist refresh tokens to meta DB when Google issues new ones during API calls
  newClient.on('tokens', async (newTokens: any) => {
    console.log(`[YouTube] Tokens refreshed for ${streamerId}`);

    const config = getStreamerConfig(streamerId);

    if (!config?.youtube?.auth) {
      console.error('[YouTube] No YouTube auth configured in tenant settings, cannot persist tokens');
    } else {
      try {
        // Decrypt current refresh token from encrypted DB field to check for changes
        let currentRefreshToken: string;
        try {
          const authObj = decryptObject<{ refresh_token?: string }>(config.youtube.auth);
          currentRefreshToken = authObj.refresh_token || '';
        } catch (_decryptError) {
          console.error('[YouTube] Failed to decrypt existing YouTube credentials');
          return; // Exit early if we can't read current state
        }

        // Determine what changed in this token event
        const shouldUpdateNewToken = newTokens.refresh_token && newTokens.refresh_token !== currentRefreshToken;

        if (!shouldUpdateNewToken && !newTokens.access_token) {
          console.warn(`[YouTube] Unexpected empty token event for ${streamerId}`);

          // Still update client credentials to maintain state
          const updateObj: any = {};
          if (newTokens.expiry_date !== undefined) updateObj.expiry_date = newTokens.expiry_date;
          if (Object.keys(updateObj).length > 0) {
            newClient.setCredentials(updateObj);
          }

          return; // Nothing to do - malformed or redundant callback
        }

        if (shouldUpdateNewToken) {
          console.log(`[YouTube] New refresh token detected - persisting to DB`);

          // Encrypt and save updated refresh token back to meta DB (single-field auth object now!)
          const encryptedAuth = encryptObject({
            refresh_token: newTokens.refresh_token, // Only this field stored per-tenant
          });

          await metaClient.tenant.update({
            where: { id: streamerId },
            data: {
              youtube: {
                ...config.youtube, // Preserve other fields (apiKey for server-side API calls)
                auth: encryptedAuth,
              } as any,
            },
          });

          console.log(`[YouTube] Refresh token persisted to DB for ${streamerId}`);

          // Clear config cache so next load gets fresh data from DB
          if (clearConfigCache) {
            clearConfigCache();

            console.log(`[YouTube] Config cache cleared for ${streamerId} - will reload on next access`);
          }
        } else {
          // Just an access token refresh event with no new refresh_token - log but don't write to DB
          console.log(`[YouTube] Access token refreshed (no DB update needed)`);
        }
      } catch (dbError: any) {
        // Log error but DON'T crash the API call - in-memory tokens still work for current session!
        console.error(`[YouTube] Failed to persist refresh token for ${streamerId}:`, dbError.message);
      } finally {
        // ALWAYS update OAuth2 client credentials with new tokens (critical for continued auth!)
        if (newTokens.access_token || newTokens.refresh_token || newTokens.expiry_date) {
          const updateObj: any = {};

          if (newTokens.access_token) updateObj.access_token = newTokens.access_token;
          if (newTokens.refresh_token) updateObj.refresh_token = newTokens.refresh_token;
          if (newTokens.expiry_date !== undefined && typeof newTokens.expiry_date === 'number') {
            updateObj.expiry_date = newTokens.expiry_date as number;
          }

          try {
            newClient.setCredentials(updateObj);

            // Also cache the updated credentials in decryptedAuthCache for next getYoutubeCredentials() call
            if (newTokens.refresh_token) {
              decryptedAuthCache.set(streamerId, {
                clientId: creds.clientId,
                clientSecret: creds.clientSecret,
                refreshToken: newTokens.refresh_token,
              });

              console.log(`[YouTube] Decrypted cache updated with fresh tokens for ${streamerId}`);
            } else if (newTokens.access_token) {
              // Access token only update - keep existing refresh token in decrypted cache
              const cachedCreds = decryptedAuthCache.get(streamerId);

              if (!cachedCreds && config?.youtube?.auth) {
                try {
                  const authObj = decryptObject<{ refresh_token?: string }>(config.youtube.auth);

                  if (authObj.refresh_token) {
                    decryptedAuthCache.set(streamerId, {
                      clientId: creds.clientId,
                      clientSecret: creds.clientSecret,
                      refreshToken: authObj.refresh_token,
                    });

                    console.log(`[YouTube] Populated decrypted cache from DB for ${streamerId}`);
                  }
                } catch (_e) {} // Ignore - will be handled on next API call
              }
            }
          } catch (setCredsError: any) {
            console.error(`[YouTube] Failed to set credentials after token refresh for ${streamerId}:`, setCredsError.message);

            throw new Error('Token refresh failed - client not updated'); // This will crash API call, which is correct
          }
        } else {
          console.warn('[YouTube] Token event received but no valid tokens to update with');
        }
      } // End of finally block
    } // End of if (config?.youtube?.auth) check
  }); // End of on('tokens') listener setup

  // Initialize client with current refresh token from DB/cache (access_token will be fetched automatically if needed)
  newClient.setCredentials({
    refresh_token: creds.refreshToken,
    access_token: null, // Force fresh token fetch if no cached valid one exists
  });

  oauthClients.set(streamerId, newClient);

  console.log(`[YouTube] Created/refreshed OAuth client for ${streamerId}`);

  return newClient;
}

function getYoutubeCredentials(streamerId: string): DecryptedYoutubeCreds | null {
  // Global OAuth2 app credentials from .env (single source of truth for all tenants)
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('[YouTube] YOUTUBE_CLIENT_ID or YOUTUBE_CLIENT_SECRET not set in .env');
    return null;
  }

  // Per-tenant refresh token from encrypted DB field (only this is tenant-specific)
  const config = getStreamerConfig(streamerId);

  if (!config?.youtube?.auth) {
    console.warn(`[YouTube] No auth configured for tenant ${streamerId}`);
    return null;
  }

  try {
    // Only decrypt refresh_token - client_id/secret come from global env vars now
    const authObj = decryptObject<{ refresh_token: string }>(config.youtube.auth);

    if (!authObj.refresh_token) {
      console.warn(`[YouTube] No refresh token found for tenant ${streamerId}`);
      return null;
    }

    // Return unified creds object (global env vars + per-tenant decrypted token)
    const creds: DecryptedYoutubeCreds = {
      clientId, // From global .env - same for all tenants
      clientSecret, // From global .env - same for all tenants
      refreshToken: authObj.refresh_token, // Per-tenant unique value from DB
    };

    return creds;
  } catch (error) {
    console.error(`Failed to decrypt YouTube credentials for ${streamerId}:`, error);
    return null;
  }
}

/**
 * Validate YouTube token without forcing refresh.
 * Uses local expiry check (Option 2) + Google API validation (Option 1).
 */
export async function validateYoutubeToken(streamerId: string): Promise<boolean> {
  const creds = getYoutubeCredentials(streamerId);

  if (!creds) return false;

  // Fast path - local expiry check on cached client (Option 2)
  const client = oauthClients.get(streamerId);
  if (client && !isTokenExpired(client)) {
    return true;
  }

  // Slow path - validate with Google API via getTokenInfo() (Option 1)
  try {
    const tempClient = new google.auth.OAuth2(creds.clientId, creds.clientSecret, REDIRECT_URI);

    if (client && client.credentials.access_token) {
      await tempClient.getTokenInfo(client.credentials.access_token as string);
      return true; // Token is valid with Google's servers
    }

    // No cached access token - will refresh on next API call automatically
    console.log(`[YouTube] No cached token for ${streamerId}, will auto-refresh on first use`);
    return true;
  } catch (error: any) {
    if (client && client.credentials.access_token) {
      console.warn(`[YouTube] Token validation failed for ${streamerId}:`, error.message);
    }
    // Don't clear cache - let next API call handle refresh naturally
    return false;
  }
}

/**
 * Backward-compatible wrapper that returns cached access token or forces refresh.
 */
export async function getAccessToken(streamerId: string): Promise<string> {
  const oauth2Client = getYoutubeOAuthClient(streamerId); // Reuses factory pattern

  const token = oauth2Client.credentials.access_token as string | undefined;

  if (token && !isTokenExpired(oauth2Client)) {
    return token; // Fast path - cached valid token exists
  }

  // No valid cache or expired - force refresh via Google API
  try {
    const credentials = await oauth2Client.getAccessToken();

    if (!credentials.token) {
      throw new Error('Failed to get YouTube access token (no token returned from OAuth client)');
    }

    return credentials.token;
  } catch (error: any) {
    // Refresh failed - likely revoked refresh_token or network error
    console.error(`[YouTube] Token refresh failed for ${streamerId}:`, error.message);
    throw new Error('Failed to get YouTube access token. You may need to re-authenticate.');
  }
}

/**
 * Clear OAuth client cache for debugging/credential rotation.
 */
export function clearYoutubeOAuthClient(streamerId?: string): void {
  if (streamerId) {
    oauthClients.delete(streamerId);

    console.log(`[YouTube] Cleared OAuth client cache for ${streamerId}`);
  } else {
    oauthClients.clear();

    console.log('[YouTube] Cleared all OAuth clients');
  }
}

// Graceful shutdown - clear cached resources
function shutdown() {
  const count = oauthClients.size;
  oauthClients.clear();

  if (count > 0) {
    console.log(`[YouTube] Shutdown: cleared ${count} cached OAuth clients`);
  } else {
    console.log('[YouTube] Shutdown: no cached clients to clear');
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export async function uploadVideo(
  streamerId: string,
  filePath: string,
  title: string,
  description: string,
  privacyStatus: 'public' | 'unlisted' | 'private'
): Promise<{ videoId: string; thumbnailUrl: string }> {
  // Single line - factory handles caching + auto-refresh
  const oauth2Client = getYoutubeOAuthClient(streamerId);

  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

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
  // Single line - factory handles caching + auto-refresh
  const oauth2Client = getYoutubeOAuthClient(streamerId);

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

export async function linkParts(streamerId: string, videoIds: { id: string; part: number }[]): Promise<void> {
  // Single line - factory handles caching + auto-refresh
  const oauth2Client = getYoutubeOAuthClient(streamerId);

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
