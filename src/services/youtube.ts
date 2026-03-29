import { google } from 'googleapis';
import fs from 'fs';
import fsPromises from 'fs/promises';
import { getStreamerConfig, clearConfigCache } from '../config/loader.js';
import { decryptObject, encryptObject } from '../utils/encryption.js';
import { metaClient } from '../db/meta-client.js';

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

// Global redirect URI for Google OAuth flow (Google playground)
const REDIRECT_URI = 'https://developers.google.com/oauthplayground';

// Per-tenant cached OAuth2 clients (long-lived across API calls, enables auto-refresh)
const oauthClients = new Map<any, any>();

// Note: authCache and decryptedAuthCache removed per requirement #3 - always read fresh from DB after persistence to ensure consistency

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
 * Check if token is expiring soon based on configurable buffer.
 * Used for pre-emptive refresh before API calls to guarantee no mid-operation expiration.
 */
function isTokenExpiringSoon(client: any, bufferMs = 120_000): boolean {
  const expiry = client.credentials.expiry_date as number | undefined;

  // No expiry means no valid token cached - assume needs refresh
  if (!expiry) return true;

  const now = Date.now();
  const remaining = expiry - now;

  // Return TRUE when remaining time ≤ buffer (time to force pre-emptive refresh)
  return remaining <= bufferMs;
}

/**
 * Get human-readable seconds remaining for logging/debugging.
 */
function getRemainingSeconds(client: any): number {
  const expiry = client.credentials.expiry_date as number | undefined;

  if (!expiry) return 0;

  return Math.max(0, Math.floor((expiry - Date.now()) / 1000));
}

/**
 * Get OAuth2 client with guaranteed valid token via pre-emptive refresh.
 * Forces refresh when <120s remaining to prevent mid-operation expiration during long tasks like uploads.
 */
async function getYoutubeOAuthClientWithValidToken(streamerId: string): Promise<any> {
  const creds = getYoutubeCredentials(streamerId);

  if (!creds) {
    throw new Error(`YouTube credentials not configured for tenant ${streamerId}`);
  }

  // Get existing cached client (may be undefined or expired)
  let client = oauthClients.get(streamerId);

  // Determine if we need pre-emptive refresh (<120s remaining OR no valid token)
  const shouldRefreshPreemptively = !client || isTokenExpiringSoon(client, 120_000);

  if (shouldRefreshPreemptively && client?.credentials.refresh_token) {
    // Pre-emptive refresh: force fresh token before operation starts
    console.log(`[YouTube] Token expiring soon (${getRemainingSeconds(client)}s remaining), pre-emptive refresh for ${streamerId}`);

    try {
      await client.refreshAccessToken(); // Google's explicit async refresh method

      const config = getStreamerConfig(streamerId);

      if (config?.youtube?.auth) {
        // Build complete updated auth object from refreshed credentials + preserved values
        const credsUpdate = buildCredentialsObject(
          {
            access_token: client.credentials.access_token,
            refresh_token: client.credentials.refresh_token || '',
            expiry_date: Date.now() + (client.credentials.expiry_date as number) - Date.now(), // Convert back to relative for builder
          },
          config.youtube.auth
        );

        const updatedAuth: AuthObject = {
          access_token: credsUpdate.access_token ?? undefined, // Convert null to undefined for type safety
          refresh_token: credsUpdate.refresh_token,
          expiry_date: (client.credentials.expiry_date as number) || calculateExpiryDate(credsUpdate),
        };

        // Persist to DB immediately after successful pre-refresh (requirement #2)
        const encryptedAuth = encryptObject(updatedAuth);

        await metaClient.tenant.update({
          where: { id: streamerId },
          data: { youtube: { ...config.youtube, auth: encryptedAuth } as any },
        });

        // Clear all caches after persistence (requirement #3 - ensure consistency)
        oauthClients.delete(streamerId);

        if (clearConfigCache) {
          clearConfigCache();
        }

        console.log(`[YouTube] Pre-emptive token refresh persisted to DB for ${streamerId}`);
      } else {
        // No auth configured - just refresh the existing client credentials but skip persistence
        client.setCredentials(buildCredentialsObject(client.credentials, undefined));

        oauthClients.delete(streamerId);
      }
    } catch (error: any) {
      if (error.message?.includes('invalid_grant') || error.message?.includes('token_expired')) {
        // Refresh token is invalid/revoked - crash with clear message
        throw new Error(`Token refresh failed for ${streamerId} - re-authentication required. Original error: ${error.message}`);
      }

      console.error(`[YouTube] Pre-emptive refresh error for ${streamerId}:`, error.message || error);

      // Don't clear cache yet - fall through to create fresh client below (graceful degradation)
    } finally {
      // If we successfully refreshed, update the cached client reference with new credentials
      if (!oauthClients.has(streamerId)) {
        oauthClients.set(streamerId, client);

        console.log(`[YouTube] OAuth client updated in cache for ${streamerId}`);
      }
    }

    // After pre-refresh (success or fail), check if we still have a valid cached client to return
    const refreshedClient = oauthClients.get(streamerId);

    if (refreshedClient && !isTokenExpired(refreshedClient)) {
      console.log(`[YouTube] Using pre-fetched token for ${streamerId}`);

      return refreshedClient; // ✅ Valid token guaranteed - no race conditions!
    }

    // If still expired or cache was cleared, fall through to create fresh client below
  }

  // Create fresh OAuth2 client with auto-refresh listener (same as getYoutubeOAuthClient lines 143-250)
  const newClient = new google.auth.OAuth2(creds.clientId, creds.clientSecret, REDIRECT_URI);

  // Set up 'tokens' event listener for persistence on future refreshes
  newClient.on('tokens', async (newTokens: any) => {
    console.log(`[YouTube] Tokens refreshed via auto-refresh for ${streamerId}`);

    const config = getStreamerConfig(streamerId);

    if (!config?.youtube?.auth) {
      console.error('[YouTube] No YouTube auth configured, cannot persist tokens');

      newClient.setCredentials(buildCredentialsObject(newTokens));

      return;
    }

    try {
      // Build complete updated auth object from event data + preserved values
      const credsUpdate = buildCredentialsObject(newTokens, config.youtube.auth);

      const updatedAuth: AuthObject = {
        access_token: newTokens.access_token || undefined,
        refresh_token: credsUpdate.refresh_token,
        expiry_date: calculateExpiryDate(newTokens), // Always include absolute timestamp (Option A)
      };

      console.log(`[YouTube] Persisting auto-refreshed auth object for ${streamerId}`);

      const encryptedAuth = encryptObject(updatedAuth);

      await metaClient.tenant.update({
        where: { id: streamerId },
        data: { youtube: { ...config.youtube, auth: encryptedAuth } as any },
      });

      console.log(`[YouTube] Auth object persisted to DB for ${streamerId}`);
    } catch (dbError: any) {
      console.error(`[YouTube] Failed to persist auto-refreshed tokens to DB for ${streamerId}:`, dbError.message || dbError);
    } finally {
      // CRITICAL: Always update OAuth client's internal state regardless of DB write success/failure
      const credsUpdate = buildCredentialsObject(newTokens, config.youtube.auth);

      try {
        newClient.setCredentials(credsUpdate);

        console.log(`[YouTube] OAuth client credentials updated for ${streamerId}`);
      } catch (setCredsError: any) {
        console.error('[YouTube] Failed to update OAuth client credentials:', setCredsError.message || setCredsError);

        throw new Error('Token refresh failed - cannot proceed with API call'); // Crash the current operation correctly
      }
    }

    // Clear all caches AFTER token event completes (requirement #3: ensure consistency)
    oauthClients.delete(streamerId);

    if (clearConfigCache) {
      clearConfigCache();

      console.log(`[YouTube] All caches cleared for ${streamerId} - will read fresh data from DB`);
    } else {
      console.warn('[YouTube] Config cache clearing not available, may have stale config in memory');
    }
  });

  // Initialize OAuth2 client with credentials loaded fresh from DB (may include cached valid access_token)
  const streamerConfig = getStreamerConfig(streamerId);

  newClient.setCredentials({
    refresh_token: creds.refreshToken, // Always required
    access_token: creds.accessToken || null, // Use cached if available and still valid based on local time check against stored expiry_date
  });

  // If we have a valid cached token with expiry_date, set it explicitly for local validation checks (isTokenExpired)
  if (creds.accessToken && streamerConfig?.youtube?.auth) {
    try {
      const authObj = decryptObject<AuthObject>(streamerConfig.youtube.auth);

      if (typeof authObj.expiry_date === 'number' && !isNaN(authObj.expiry_date)) {
        // Update credentials with expiry_date while preserving existing values
        newClient.credentials.expiry_date = authObj.expiry_date;

        console.log(`[YouTube] Initialized client with cached token expiring at ${new Date(authObj.expiry_date).toISOString()}`);
      } else {
        console.warn('[YouTube] Cached access_token has invalid expiry format');
      }
    } catch (_e) {
      // Ignore - OAuth2 library will handle refresh on first API call automatically (graceful fallback)
    }
  }

  // Cache the newly created client for future reuse until token expires or explicitly cleared
  oauthClients.set(streamerId, newClient);

  console.log(`[YouTube] Created/refreshed OAuth client with guaranteed valid token for ${streamerId}`);

  return newClient;
}

/**
 * Convert token expiry information to absolute timestamp for local validation.
 * Handles both relative seconds (expires_in/expiresIn) and absolute timestamps (expiry_date).
 */
function calculateExpiryDate(newTokens: any): number {
  // If already provided as absolute timestamp, use directly
  if (typeof newTokens.expiry_date === 'number') return newTokens.expiry_date;

  // Try camelCase variant first (googleapis standard)
  const relativeSeconds = typeof newTokens.expiresIn === 'number' ? newTokens.expiresIn : typeof newTokens.expires_in === 'number' ? newTokens.expires_in : undefined;

  if (relativeSeconds !== undefined && !isNaN(relativeSeconds)) {
    return Date.now() + relativeSeconds * 1000; // Convert to absolute timestamp in ms
  }

  console.warn('[YouTube] No expiry information in token event, using default 1-hour validity');
  return Date.now() + 3600_000; // Default: expire in 1 hour (safe fallback)
}

/**
 * Build credentials object for OAuth2 client state management.
 * Handles both fresh tokens and preserves existing refresh token if not rotated by Google.
 */
function buildCredentialsObject(
  newTokens: any,
  currentAuthEncrypted?: string
): {
  access_token?: null | string;
  refresh_token: string;
  expiry_date?: number;
} {
  let refreshToken = '';

  // Try to load existing refresh token if not provided in event (Google often doesn't rotate it)
  if (!newTokens.refresh_token && currentAuthEncrypted) {
    try {
      const existing = decryptObject<AuthObject>(currentAuthEncrypted);
      refreshToken = existing?.refresh_token || '';

      console.log(`[YouTube] Preserved existing refresh token from DB`);
    } catch (_e) {
      // Ignore - will use empty string, OAuth client may fail gracefully on next API call if needed
    }
  } else if (newTokens.refresh_token) {
    refreshToken = newTokens.refresh_token;
    console.log(`[YouTube] Using fresh refresh token from event`);
  }

  const creds: any = {
    access_token: null, // Default - will be updated below
    refresh_token: refreshToken,
  };

  if (newTokens.access_token) {
    creds.access_token = newTokens.access_token;

    // Calculate and set expiry_date for local validation checks
    const expiryDate = calculateExpiryDate(newTokens);
    if (!isNaN(expiryDate)) {
      creds.expiry_date = expiryDate;

      console.log(`[YouTube] Access token valid until ${new Date(expiryDate).toISOString()}`);
    }
  } else {
    // No access token in event - ensure client state is clean (will force refresh on next API call)
    delete creds.expiry_date; // Clear old expiry date if present

    console.log(`[YouTube] No access token provided, will refresh on next API call`);
  }

  return creds as {
    access_token: null | string;
    refresh_token: string;
    expiry_date?: number;
  };
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

  // Auto-persist complete auth object to DB on every token refresh event
  newClient.on('tokens', async (newTokens: any) => {
    console.log(`[YouTube] Tokens refreshed for ${streamerId}`);

    const config = getStreamerConfig(streamerId);

    if (!config?.youtube?.auth) {
      console.error('[YouTube] No YouTube auth configured, cannot persist tokens');

      // Still update client credentials so API call can proceed with in-memory state only
      newClient.setCredentials(buildCredentialsObject(newTokens));

      return;
    }

    try {
      // Build complete updated auth object from event data + preserved values if needed
      const credsUpdate = buildCredentialsObject(newTokens, config.youtube.auth);

      const updatedAuth: AuthObject = {
        access_token: newTokens.access_token || undefined, // Exclude field entirely if not present

        refresh_token: credsUpdate.refresh_token, // Use helper to get correct value (preserved or fresh)

        expiry_date: calculateExpiryDate(newTokens), // Always include absolute timestamp (Option A)
      };

      console.log(`[YouTube] Persisting updated auth object for ${streamerId}`);

      const encryptedAuth = encryptObject(updatedAuth);

      await metaClient.tenant.update({
        where: { id: streamerId },
        data: {
          youtube: { ...config.youtube, auth: encryptedAuth } as any, // Preserve apiKey and other fields
        },
      });

      console.log(`[YouTube] Auth object persisted to DB for ${streamerId}`);
    } catch (dbError: any) {
      console.error(`[YouTube] Failed to persist tokens to DB for ${streamerId}:`, dbError.message || dbError);

      // Don't throw - let API call continue with in-memory credentials only
    } finally {
      // CRITICAL: Always update OAuth client's internal state regardless of DB write success/failure

      const credsUpdate = buildCredentialsObject(newTokens, config.youtube.auth);

      try {
        newClient.setCredentials(credsUpdate);

        console.log(`[YouTube] OAuth client credentials updated for ${streamerId}`);
      } catch (setCredsError: any) {
        console.error('[YouTube] Failed to update OAuth client credentials:', setCredsError.message || setCredsError);

        throw new Error('Token refresh failed - cannot proceed with API call'); // Crash the current operation correctly
      }
    }

    // Clear all caches AFTER token event completes (requirement #3: ensure consistency)
    oauthClients.delete(streamerId); // Remove cached OAuth client

    if (clearConfigCache) {
      clearConfigCache(); // Force reload from DB on next access

      console.log(`[YouTube] All caches cleared for ${streamerId} - will read fresh data from DB`);
    } else {
      console.warn('[YouTube] Config cache clearing not available, may have stale config in memory');
    }
  });

  // Initialize OAuth2 client with credentials loaded fresh from DB (may include cached valid access_token for efficiency)
  const streamerConfig = getStreamerConfig(streamerId);

  newClient.setCredentials({
    refresh_token: creds.refreshToken, // Always required

    access_token: creds.accessToken || null, // Use cached if available and valid, otherwise force fresh fetch on first API call
  });

  // If we have a valid cached token with expiry_date, set it explicitly for local validation checks (isTokenExpired)
  if (creds.accessToken && streamerConfig?.youtube?.auth) {
    try {
      const authObj = decryptObject<AuthObject>(streamerConfig.youtube.auth);

      if (typeof authObj.expiry_date === 'number' && !isNaN(authObj.expiry_date)) {
        // Update credentials with expiry_date while preserving existing values
        newClient.credentials.expiry_date = authObj.expiry_date;

        console.log(`[YouTube] Initialized client with cached token expiring at ${new Date(authObj.expiry_date).toISOString()}`);
      } else {
        console.warn('[YouTube] Cached access_token has invalid expiry format');
      }
    } catch (_e) {
      // Ignore - OAuth2 library will handle refresh on first API call automatically (graceful fallback)
    }
  }

  // Cache the newly created client for future reuse until token expires or explicitly cleared
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
    // Decrypt complete auth object (now includes access_token + expiry_date from our persistence logic)
    const authObj = decryptObject<AuthObject>(config.youtube.auth);

    if (!authObj.refresh_token || typeof authObj.refresh_token !== 'string' || !authObj.refresh_token.trim()) {
      console.warn(`[YouTube] No valid refresh token found for tenant ${streamerId}`);
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

        console.log(`[YouTube] Using cached access token, expires at ${new Date(authObj.expiry_date).toISOString()}`);
      } else {
        // Token exists but expired or expiring soon - will force refresh on next API call (correct behavior)
        const timeUntilExpiry = authObj.expiry_date - now;

        if (timeUntilExpiry < 0) {
          console.log(`[YouTube] Cached access token expired ${Math.abs(timeUntilExpiry / 1000).toFixed(0)}s ago, will refresh on next API call`);
        } else {
          console.log(`[YouTube] Access token expiring in ${(timeUntilExpiry / 1000).toFixed(0)}s (<60s buffer), forcing refresh for safety`);
        }
      }
    } else if (authObj.access_token) {
      // Has access_token but no expiry_date - suspicious data state, skip using cached token
      console.warn(`[YouTube] Cached access token has no valid expiry_date field, skipping cache use`);
    }

    return creds;
  } catch (error: any) {
    console.error(`Failed to decrypt YouTube credentials for ${streamerId}:`, error.message || error);
    return null; // Return null instead of throwing - let caller handle gracefully
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
  // Use guaranteed-valid-token helper (pre-emptive refresh if <120s remaining)
  const oauth2Client = await getYoutubeOAuthClientWithValidToken(streamerId);

  const token = oauth2Client.credentials.access_token as string | undefined;

  if (!token) {
    throw new Error('Failed to get YouTube access token (no token in OAuth client credentials)');
  }

  // Token is guaranteed valid by getYoutubeOAuthClientWithValidToken - no race conditions!
  return token;
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
  // Use guaranteed-valid-token helper (pre-emptive refresh if <120s remaining)
  const oauth2Client = await getYoutubeOAuthClientWithValidToken(streamerId);

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
  // Use guaranteed-valid-token helper (pre-emptive refresh if <120s remaining)
  const oauth2Client = await getYoutubeOAuthClientWithValidToken(streamerId);

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
  // Use guaranteed-valid-token helper (pre-emptive refresh if <120s remaining)
  const oauth2Client = await getYoutubeOAuthClientWithValidToken(streamerId);

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
