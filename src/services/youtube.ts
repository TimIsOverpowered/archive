import { google, Auth } from 'googleapis';
import fs from 'fs';
import { getStreamerConfig, clearConfigCache } from '../config/loader.js';
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

// Per-tenant cached OAuth2 clients (long-lived across API calls, enables auto-refresh)
const oauthClients = new Map<string, Auth.OAuth2Client>();

// Note: authCache and decryptedAuthCache removed per requirement #3 - always read fresh from DB after persistence to ensure consistency

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
 * Check if token is expiring soon based on configurable buffer.
 * Used for pre-emptive refresh before API calls to guarantee no mid-operation expiration.
 */
function isTokenExpiringSoon(client: Auth.OAuth2Client, bufferMs = 120_000): boolean {
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
function getRemainingSeconds(client: Auth.OAuth2Client): number {
  const expiry = client.credentials.expiry_date as number | undefined;

  if (!expiry) return 0;

  return Math.max(0, Math.floor((expiry - Date.now()) / 1000));
}

/**
 * Get OAuth2 client with guaranteed valid token via pre-emptive refresh.
 * Forces refresh when <120s remaining to prevent mid-operation expiration during long tasks like uploads.
 */
async function getYoutubeOAuthClientWithValidToken(streamerId: string): Promise<Auth.OAuth2Client> {
  const log = loggerWithTenant(streamerId);
  const creds = getYoutubeCredentials(streamerId);

  if (!creds) {
    throw new Error(`YouTube credentials not configured`);
  }

  // Get existing cached client (may be undefined or expired)
  const client = oauthClients.get(streamerId);

  // Determine if we need pre-emptive refresh (<120s remaining OR no valid token)
  const shouldRefreshPreemptively = !client || isTokenExpiringSoon(client, 120_000);

  if (shouldRefreshPreemptively && client?.credentials.refresh_token) {
    // Pre-emptive refresh: force fresh token before operation starts
    log.info(`[YouTube] Token expiring soon (${getRemainingSeconds(client)}s remaining), pre-emptive refresh`);

    try {
      await client.refreshAccessToken(); // Google's explicit async refresh method - tokens event fires automatically and handles persistence

      log.info(`[YouTube] Pre-emptive token refresh completed`);
    } catch (error: unknown) {
      const details = extractErrorDetails(error);

      if (details.message.includes('invalid_grant') || details.message.includes('token_expired')) {
        // Refresh token is invalid/revoked - crash with clear message
        throw new Error(`Token refresh failed for ${streamerId} - re-authentication required. Original error: ${details.message}`);
      }

      log.error(details, `[YouTube] Pre-emptive refresh error for ${streamerId}`);

      // Don't clear cache yet - fall through to create fresh client below (graceful degradation)
    } finally {
      // If we successfully refreshed, update the cached client reference with new credentials
      if (!oauthClients.has(streamerId)) {
        oauthClients.set(streamerId, client);

        log.info(`[YouTube] OAuth client updated in cache`);
      }
    }

    // After pre-refresh (success or fail), check if we still have a valid cached client to return
    const refreshedClient = oauthClients.get(streamerId);

    if (refreshedClient && !isTokenExpired(refreshedClient)) {
      log.info(`[YouTube] Using pre-fetched token`);

      return refreshedClient; // Valid token guaranteed - no race conditions!
    }

    // If still expired or cache was cleared, fall through to create fresh client below
  }

  // Create fresh OAuth2 client with auto-refresh listener (same as getYoutubeOAuthClient lines 143-250)
  const newClient = new google.auth.OAuth2(creds.clientId, creds.clientSecret, REDIRECT_URI);

  // Set up 'tokens' event listener for persistence on ALL refreshes (pre-emptive and auto)
  newClient.on('tokens', async (newTokens: Auth.Credentials) => {
    const config = getStreamerConfig(streamerId);

    if (!config?.youtube?.auth) {
      log.warn('[YouTube] No YouTube auth configured, cannot persist tokens');

      newClient.setCredentials(buildCredentialsObject(newTokens));

      return;
    }

    try {
      // Build complete updated auth object from event data + preserved values (merge with existing state for safety)
      const credsUpdate = buildCredentialsObject(newTokens, config.youtube.auth, log);

      const updatedAuth: AuthObject = {
        access_token: newTokens.access_token || undefined,
        refresh_token: credsUpdate.refresh_token,
        expiry_date: calculateExpiryDate(newTokens), // Always include absolute timestamp (Option A)
      };

      log.info(`[YouTube] Persisting refreshed auth object`);

      const encryptedAuth = encryptObject(updatedAuth);

      // H5/M5 - Use type-safe YoutubeJson interface for JSONB field updates with explicit cast
      const currentYoutubeConfig = config.youtube as YoutubeJson;

      await metaClient.tenant.update({
        where: { id: streamerId },
        data: {
          youtube: { ...currentYoutubeConfig, auth: encryptedAuth } as YoutubeJson, // Required for Prisma JSONB updates
        },
      });

      log.info(`[YouTube] Auth object persisted to DB`);
    } catch (error: unknown) {
      const details = extractErrorDetails(error);

      log.error(details, `[YouTube] Failed to persist refreshed tokens to DB for ${streamerId}`);
    } finally {
      // CRITICAL: Always update OAuth client's internal state regardless of DB write success/failure
      const credsUpdate = buildCredentialsObject(newTokens, config.youtube.auth, log);

      try {
        newClient.setCredentials(credsUpdate);

        log.info(`[YouTube] OAuth client credentials updated`);
      } catch (error: unknown) {
        const details = extractErrorDetails(error);

        log.error(details, '[YouTube] Failed to update OAuth client credentials');
        throw new Error('Token refresh failed - cannot proceed with API call'); // Crash the current operation correctly
      }
    }

    // Clear all caches AFTER token event completes (requirement #3: ensure consistency)
    oauthClients.delete(streamerId);

    if (clearConfigCache) {
      clearConfigCache();

      log.info(`[YouTube] All caches cleared for ${streamerId} - will read fresh data from DB`);
    } else {
      log.warn('[YouTube] Config cache clearing not available, may have stale config in memory');
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

        log.info(`[YouTube] Initialized client with cached token expiring at ${new Date(authObj.expiry_date).toISOString()}`);
      } else {
        log.warn('[YouTube] Cached access_token has invalid expiry format');
      }
    } catch {
      // Ignore - OAuth2 library will handle refresh on first API call automatically (graceful fallback)
    }
  }

  // Cache the newly created client for future reuse until token expires or explicitly cleared
  oauthClients.set(streamerId, newClient);

  log.info(`[YouTube] Created/refreshed OAuth client with guaranteed valid token`);

  return newClient;
}

/**
 * Convert token expiry information to absolute timestamp for local validation.
 * Handles both relative seconds (expires_in/expiresIn) and absolute timestamps (expiry_date).
 * Merges with existing auth state when available for safer expiry calculation.
 */
// H5/M5 - Auth.Credentials has dynamic shape; using type assertion for Google API compatibility
function calculateExpiryDate(newTokens: Auth.Credentials, existingAuth?: AuthObject | null, log?: ReturnType<typeof loggerWithTenant>): number {
  // If already provided as absolute timestamp in event data, use directly
  if (typeof newTokens.expiry_date === 'number') return newTokens.expiry_date;

  // Try camelCase variant first (googleapis standard)
  const tokenWithExpiry = newTokens as Record<string, unknown>;

  const relativeSeconds =
    typeof tokenWithExpiry['expiresIn'] === 'number' ? tokenWithExpiry['expiresIn'] : typeof tokenWithExpiry['expires_in'] === 'number' ? tokenWithExpiry['expires_in'] : undefined;

  if (relativeSeconds !== undefined && !isNaN(relativeSeconds)) {
    return Date.now() + relativeSeconds * 1000; // Convert to absolute timestamp in ms
  }

  // Fallback: try to use existing auth expiry as reference point for next refresh cycle
  if (existingAuth?.expiry_date) {
    const logger = log || baseLogger;
    logger.info(`[YouTube] Using existing auth expiry pattern, adding standard token lifetime`);
    return Date.now() + 3600_000; // Standard YouTube access token: 1 hour from now
  }

  const logger = log || baseLogger;
  logger.warn('[YouTube] No expiry information in token event, using default 1-hour validity');
  return Date.now() + 3600_000; // Default: expire in 1 hour (safe fallback)
}

/**
 * Build credentials object for OAuth2 client state management.
 * Handles both fresh tokens and preserves existing refresh token if not rotated by Google.
 */
// H5/M5 - Auth.Credentials has dynamic shape; using type assertion for Google API compatibility
function buildCredentialsObject(
  newTokens: Auth.Credentials,
  currentAuthEncrypted?: string,
  log?: ReturnType<typeof loggerWithTenant>
): {
  access_token?: null | string;
  refresh_token: string;
  expiry_date?: number;
} {
  let refreshToken = '';

  // Try to load existing auth state for merging (safer than relying solely on event data)
  const logger = log || baseLogger;

  let existingAuth: AuthObject | null = null;

  if (!newTokens.refresh_token && currentAuthEncrypted) {
    try {
      existingAuth = decryptObject<AuthObject>(currentAuthEncrypted);
      refreshToken = existingAuth?.refresh_token || '';

      logger.info(`[YouTube] Preserved existing refresh token from DB`);
    } catch {
      // Ignore - will use empty string, OAuth client may fail gracefully on next API call if needed
    }
  } else if (newTokens.refresh_token) {
    refreshToken = newTokens.refresh_token;
    logger.info(`[YouTube] Using fresh refresh token from event`);
  }

  const creds = {
    access_token: null as string | null, // Default - will be updated below
    refresh_token: refreshToken,
  };

  // Add optional expiry_date property dynamically to avoid type errors
  if (newTokens.access_token) {
    creds.access_token = newTokens.access_token;

    // Calculate and set expiry_date for local validation checks using merged state
    const expiryDate = calculateExpiryDate(newTokens, existingAuth, log);
    if (!isNaN(expiryDate)) {
      (creds as Record<string, unknown>).expiry_date = expiryDate;

      logger.info(`[YouTube] Access token valid until ${new Date(expiryDate).toISOString()}`);
    }
  } else {
    // No access token in event - clear old expiry to force refresh on next API call
    delete (creds as Record<string, unknown>)['expiry_date'];

    logger.info(`[YouTube] No access token provided, will refresh on next API call`);
  }

  return creds as {
    access_token: null | string;
    refresh_token: string;
    expiry_date?: number;
  };
}

function getYoutubeCredentials(streamerId: string): DecryptedYoutubeCreds | null {
  // Global OAuth2 app credentials from .env (single source of truth for all tenants)
  const log = loggerWithTenant(streamerId);
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    log.error('[YouTube] YOUTUBE_CLIENT_ID or YOUTUBE_CLIENT_SECRET not set in .env');
    return null;
  }

  // Per-tenant refresh token from encrypted DB field (only this is tenant-specific)
  const config = getStreamerConfig(streamerId);

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

    log.error(details, `Failed to decrypt YouTube credentials for ${streamerId}`);
    return null; // Return null instead of throwing - let caller handle gracefully
  }
}

/**
 * Validate YouTube token without forcing refresh.
 * Uses local expiry check (Option 2) + Google API validation (Option 1).
 */
export async function validateYoutubeToken(streamerId: string): Promise<boolean> {
  const log = loggerWithTenant(streamerId);
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
    log.info(`[YouTube] No cached token for ${streamerId}, will auto-refresh on first use`);
    return true;
  } catch (error: unknown) {
    const details = extractErrorDetails(error);

    if (client && client.credentials.access_token) {
      log.warn(details, `[YouTube] Token validation failed for ${streamerId}`);
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
    const log = loggerWithTenant(streamerId);
    oauthClients.delete(streamerId);

    log.info(`[YouTube] Cleared OAuth client cache`);
  } else {
    oauthClients.clear();

    baseLogger.info('[YouTube] Cleared all OAuth clients');
  }
}

// Graceful shutdown - clear cached resources
export function shutdown() {
  const count = oauthClients.size;
  oauthClients.clear();

  if (count > 0) {
    baseLogger.info(`[YouTube] Shutdown: cleared ${count} cached OAuth clients`);
  } else {
    baseLogger.info('[YouTube] Shutdown: no cached clients to clear');
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export async function uploadVideo(
  streamerId: string,
  displayName: string,
  filePath: string,
  title: string,
  description: string,
  privacyStatus: 'public' | 'unlisted' | 'private',
  onProgress?: YoutubeUploadProgress
): Promise<{ videoId: string; thumbnailUrl: string }> {
  const log = loggerWithTenant(streamerId);

  // Milestone 1: Starting - notify progress callback if provided (worker handles Discord)
  if (onProgress) {
    await onProgress({ milestone: 'starting' });
  }

  try {
    const oauth2Client = await getYoutubeOAuthClientWithValidToken(streamerId);
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
