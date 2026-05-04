import path from 'node:path';
import { z } from 'zod';
import { YouTube } from '../constants.js';
import { decryptObject, decryptScalar } from '../utils/encryption.js';

/**
 * Zod schema for an encrypted string field.
 * Decrypts non-empty values automatically at parse time.
 * Empty or undefined values pass through unchanged.
 */
function encryptedString() {
  return z
    .string()
    .optional()
    .transform((val) => {
      if (val == null || val === '') return val ?? '';
      return decryptScalar(val);
    });
}

function normalizePathForSchema(basePath?: string): string | undefined {
  if (basePath == null || basePath === '') return undefined;
  const normalized = path.normalize(basePath);
  return normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) ? normalized : path.resolve(normalized);
}

/**
 * Tenant-level settings controlling which features are enabled and storage paths.
 */
export const SettingsSchema = z.object({
  /** Domain name associated with the tenant */
  domainName: z.string().min(1, 'domainName is required'),
  /** IANA timezone identifier (e.g. 'America/New_York') */
  timezone: z.string().min(1, 'timezone is required'),
  /** Whether to save the final MP4 file (default: false) */
  saveMP4: z.boolean().default(false),
  /** Whether to save raw HLS segments (default: false) */
  saveHLS: z.boolean().default(false),
  /** Whether to download VODs after stream ends (default: true) */
  vodDownload: z.boolean().default(true),
  /** Whether to download chat messages (default: true) */
  chatDownload: z.boolean().default(true),
  /** Base path for storing VOD files, normalized to absolute */
  vodPath: z
    .string()
    .optional()
    .transform((p): string | undefined => (p != null && p !== '' ? normalizePathForSchema(p) : undefined)),
  /** Base path for storing live stream files, normalized to absolute */
  livePath: z
    .string()
    .optional()
    .transform((p): string | undefined => (p != null && p !== '' ? normalizePathForSchema(p) : undefined)),
});

/** YouTube OAuth token credentials. */
export const YoutubeAuthSchema = z.object({
  /** OAuth access token (may be expired) */
  access_token: z.string().optional(),
  /** OAuth refresh token — required for token renewal */
  refresh_token: z.string(),
  /** Unix timestamp when access_token expires */
  expiry_date: z.number(),
  /** OAuth scope string */
  scope: z.string().optional(),
  /** OAuth token type (usually 'Bearer') */
  token_type: z.string().optional(),
});

export type YoutubeAuthObject = z.infer<typeof YoutubeAuthSchema>;

/**
 * Zod schema for an encrypted YouTube auth JSON object field.
 * Decrypts and parses non-empty values automatically at parse time.
 */
function encryptedYoutubeAuth() {
  return z.any().transform((val) => {
    if (typeof val !== 'string' || val === '') return undefined;
    return decryptObject<YoutubeAuthObject>(val);
  });
}

/** YouTube upload configuration for a tenant. */
export const YoutubeSchema = z.object({
  /** Make uploads publicly visible (default: true) */
  public: z.boolean().default(true),
  /** Enable YouTube uploads (default: true) */
  upload: z.boolean().default(true),
  /** Upload VODs to YouTube (default: true) */
  vodUpload: z.boolean().default(true),
  /** Upload live streams to YouTube (default: false) */
  liveUpload: z.boolean().default(false),
  /** Enable multi-track audio upload (default: false) */
  multiTrack: z.boolean().default(false),
  /** Maximum duration per upload in seconds (default: 3600) */
  splitDuration: z.number().default(YouTube.MAX_DURATION),
  /** Upload game highlight clips separately (default: false) */
  perGameUpload: z.boolean().default(false),
  /** List of restricted game names for per-game upload filtering */
  restrictedGames: z.array(z.string().nullable()).default([]),
  /** Custom upload description template */
  description: z.string().default(''),
  /** Decrypted YouTube API auth object (decrypted at parse time) */
  auth: encryptedYoutubeAuth().optional(),
  /** Encrypted YouTube API key (decrypted at parse time) */
  apiKey: encryptedString().optional(),
});

/** Twitch API OAuth credentials. */
export const TwitchAuthSchema = z.object({
  /** Twitch API client ID */
  client_id: z.string(),
  /** Twitch API client secret */
  client_secret: z.string(),
  /** OAuth access token (may be expired) */
  access_token: z.string().optional(),
  /** Unix timestamp when access_token expires */
  expiry_date: z.number().optional(),
});

export type TwitchAuthObject = z.infer<typeof TwitchAuthSchema>;

/**
 * Zod schema for an encrypted Twitch auth JSON object field.
 * Decrypts and parses non-empty values automatically at parse time.
 */
function encryptedTwitchAuth() {
  return z.any().transform((val) => {
    if (typeof val !== 'string' || val === '') return undefined;
    return decryptObject<TwitchAuthObject>(val);
  });
}

/** Twitch platform configuration for a tenant. */
export const TwitchSchema = z.object({
  /** Enable Twitch streaming (default: false) */
  enabled: z.boolean().default(false),
  /** Mark as the primary platform (default: false) */
  mainPlatform: z.boolean().default(false),
  /** Decrypted Twitch API auth object (decrypted at parse time) */
  auth: encryptedTwitchAuth().optional(),
  /** Twitch username / display name */
  username: z
    .string()
    .optional()
    .nullable()
    .transform((val) => val ?? undefined),
  /** Twitch user ID */
  id: z
    .string()
    .optional()
    .nullable()
    .transform((val) => val ?? undefined),
});

export type TwitchConfig = z.infer<typeof TwitchSchema>;
export type YouTubeConfig = z.infer<typeof YoutubeSchema>;
export type KickConfig = z.infer<typeof KickSchema>;
export type TenantSettings = z.infer<typeof SettingsSchema>;

/** Kick platform configuration for a tenant. */
export const KickSchema = z.object({
  /** Enable Kick streaming (default: false) */
  enabled: z.boolean().default(false),
  /** Mark as the primary platform (default: false) */
  mainPlatform: z.boolean().default(false),
  /** Kick user ID */
  id: z.string().optional(),
  /** Kick username */
  username: z.string().optional(),
});

// ── Operation Schemas ──────────────────────────────────────────────────────

/** Schema for creating a new VOD record. */
export const VodCreateSchema = z.object({
  /** External platform VOD ID (string to preserve large IDs) */
  platformVodId: z.string().optional(),
  /** VOD title, nullable for live streams */
  title: z.string().nullable().default(null),
  /** VOD creation timestamp */
  created_at: z.coerce.date(),
  /** Duration in seconds (default: 0 for live streams) */
  duration: z.number().default(0),
  /** Platform stream/session ID */
  platformStreamId: z.string().nullable().default(null),
  /** Source platform */
  platform: z.enum(['twitch', 'kick']),
  /** Whether this VOD originated from a live stream (default: false) */
  is_live: z.boolean().default(false),
});

/** Schema for updating an existing VOD record. */
export const VodUpdateSchema = z.object({
  /** External platform VOD ID (optional) */
  platformVodId: z.string().optional(),
  /** VOD title (nullable) */
  title: z.string().nullable().default(null),
  /** VOD creation timestamp (optional) */
  created_at: z.coerce.date().optional(),
  /** Duration in seconds (optional) */
  duration: z.number().optional(),
  /** Platform stream ID (nullable) */
  platformStreamId: z.string().nullable().default(null),
});

/** Schema for creating a chapter within a VOD. */
export const ChapterCreateSchema = z.object({
  /** VOD ID (integer) */
  vod_id: z.number(),
  /** Chapter start time in seconds */
  start: z.number(),
  /** Chapter end time in seconds (nullable for open-ended) */
  end: z.number().nullable().default(null),
  /** Chapter title (nullable) */
  title: z.string().nullable().default(null),
  /** Game/Category ID (nullable) */
  game_id: z.string().nullable().default(null),
});

/** Schema for updating an existing chapter. */
export const ChapterUpdateSchema = z.object({
  /** Chapter start time in seconds (optional) */
  start: z.number().optional(),
  /** Chapter end time in seconds (nullable) */
  end: z.number().nullable().default(null),
  /** Chapter title (nullable) */
  title: z.string().nullable().default(null),
  /** Game/Category ID (nullable) */
  game_id: z.string().nullable().default(null),
});

/** Schema for upserting a game/category record. */
export const GameUpsertSchema = z.object({
  /** External game ID */
  game_id: z.string(),
  /** Game/Category display name */
  game_name: z.string(),
  /** URL to game box art image (nullable) */
  box_art_url: z.string().url().nullable().default(null),
});

/** Schema for upserting emote data for a VOD. */
export const EmoteUpsertSchema = z.object({
  /** VOD ID (integer) */
  vod_id: z.number(),
  /** Frazzel emotes (id as string, code as string) */
  ffz_emotes: z.array(z.object({ id: z.string(), code: z.string() })).default([]),
  /** BetterTTV emotes (id as string, code as string) */
  bttv_emotes: z.array(z.object({ id: z.string(), code: z.string() })).default([]),
  /** 7TV emotes (id, code from name, optional flags) */
  seventv_emotes: z.array(z.object({ id: z.string(), code: z.string(), flags: z.number().optional() })).default([]),
});
