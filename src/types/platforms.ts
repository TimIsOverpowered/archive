/**
 * Centralized platform and type constants.
 *
 * Single source of truth for all platform identifiers and content type literals.
 * Adding a new platform requires changes only in this file.
 */

// ============================================================================
// Platform Constants
// ============================================================================

/**
 * Supported streaming platforms.
 * Add new platforms here (e.g., YOUTUBE: 'youtube') when support is added.
 */
export const PLATFORMS = {
  TWITCH: 'twitch',
  KICK: 'kick',
} as const;

/** Platform identifier type derived from PLATFORMS object. */
export type Platform = (typeof PLATFORMS)[keyof typeof PLATFORMS];

// ============================================================================
// Source Type Constants
// ============================================================================

/**
 * Source type describes where the media came from (monitoring loop context).
 * Used to distinguish between live streams and recorded VODs.
 */
export const SOURCE_TYPES = {
  LIVE: 'live',
  VOD: 'vod',
} as const;

/** Source type identifier derived from SOURCE_TYPES object. */
export type SourceType = (typeof SOURCE_TYPES)[keyof typeof SOURCE_TYPES];

// ============================================================================
// Upload Type Constants
// ============================================================================

/**
 * Upload type describes what the media is in the context of YouTube uploads.
 * Separate from SourceType to prevent logic leakage between domains.
 */
export const UPLOAD_TYPES = {
  VOD: 'vod',
  GAME: 'game',
} as const;

/** Upload type identifier derived from UPLOAD_TYPES object. */
export type UploadType = (typeof UPLOAD_TYPES)[keyof typeof UPLOAD_TYPES];

// ============================================================================
// Upload Mode Constants
// ============================================================================

/**
 * Upload mode determines what content to upload.
 * 'vod' = upload only the full VOD
 * 'all' = upload VOD plus game clips (if perGameUpload is enabled)
 */
export const UPLOAD_MODES = {
  VOD: 'vod',
  ALL: 'all',
} as const;

/** Upload mode identifier derived from UPLOAD_MODES object. */
export type UploadMode = (typeof UPLOAD_MODES)[keyof typeof UPLOAD_MODES];

// ============================================================================
// Download Method Constants
// ============================================================================

/**
 * Download method for VOD retrieval.
 * 'ffmpeg' = use ffmpeg for downloading
 * 'hls' = use HLS manifest parsing
 */
export const DOWNLOAD_METHODS = {
  FFMPEG: 'ffmpeg',
  HLS: 'hls',
} as const;

/** Download method identifier derived from DOWNLOAD_METHODS object. */
export type DownloadMethod = (typeof DOWNLOAD_METHODS)[keyof typeof DOWNLOAD_METHODS];

// ============================================================================
// Type Guard Utilities
// ============================================================================

/** Validates if a string is a valid platform. */
export function isValidPlatform(value: string): value is Platform {
  return Object.values(PLATFORMS).includes(value as Platform);
}

/** Validates if a string is a valid source type. */
export function isValidSourceType(value: string): value is SourceType {
  return Object.values(SOURCE_TYPES).includes(value as SourceType);
}

/** Validates if a string is a valid upload type. */
export function isValidUploadType(value: string): value is UploadType {
  return Object.values(UPLOAD_TYPES).includes(value as UploadType);
}

/** Validates if a string is a valid upload mode. */
export function isValidUploadMode(value: string): value is UploadMode {
  return Object.values(UPLOAD_MODES).includes(value as UploadMode);
}

/** Validates if a string is a valid download method. */
export function isValidDownloadMethod(value: string): value is DownloadMethod {
  return Object.values(DOWNLOAD_METHODS).includes(value as DownloadMethod);
}

// ============================================================================
// Formatting Utilities
// ============================================================================

/**
 * Capitalizes a platform name for display purposes.
 * @example capitalizePlatform('twitch') => 'Twitch'
 */
export function capitalizePlatform(platform: Platform): string {
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}
