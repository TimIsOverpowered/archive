import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { getTmpPath, getVodPath, getLivePath } from '../config/env.js';
import { ConfigNotConfiguredError } from './domain-errors.js';
import { extractErrorDetails } from './error.js';
import { childLogger } from './logger.js';

const log = childLogger({ module: 'path' });

/**
 * Checks if a file exists at the given path.
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deletes a file if it exists, ignoring errors if the file doesn't exist.
 */
export async function deleteFileIfExists(filePath: string): Promise<void> {
  if (await fileExists(filePath)) {
    await fsPromises.unlink(filePath).catch((err) => {
      const details = extractErrorDetails(err);
      log.warn({ filePath, error: details.message }, 'Failed to delete file');
    });
  }
}

export interface VodPathOptions {
  tenantId: string;
  vodId: string;
}

export interface LivePathOptions {
  tenantId: string;
  streamId: string | null;
}

/**
 * Gets the tmp directory path for a VOD.
 * Path: {TMP_PATH}/{tenantId}/{vodId}
 */
export function getTmpDirPath(options: VodPathOptions): string {
  const tmpPath = getTmpPath();
  if (tmpPath == null) {
    throw new ConfigNotConfiguredError('TMP_PATH is not configured');
  }
  return path.join(tmpPath, options.tenantId, options.vodId);
}

/**
 * Gets the tmp file path for a VOD.
 * Path: {TMP_PATH}/{tenantId}/{vodId}/{vodId}.mp4
 */
export function getTmpFilePath(options: VodPathOptions): string {
  const tmpPath = getTmpPath();
  if (tmpPath == null) {
    throw new ConfigNotConfiguredError('TMP_PATH is not configured');
  }
  return path.join(tmpPath, options.tenantId, options.vodId, `${options.vodId}.mp4`);
}

/**
 * Gets the file path for an archived VOD.
 * Path: {VOD_PATH}/{tenantId}/{vodId}/{vodId}.mp4
 */
export function getVodFilePath(options: VodPathOptions): string {
  const vodPath = getVodPath();
  if (vodPath == null) throw new Error('VOD_PATH is not configured');
  return path.join(vodPath, options.tenantId, options.vodId, `${options.vodId}.mp4`);
}

/**
 * Gets the file path for a live VOD.
 * Path: {LIVE_PATH}/{tenantId}/{streamId}/{streamId}.mp4
 */
export function getLiveFilePath(options: LivePathOptions): string {
  const livePath = getLivePath();
  if (livePath == null) throw new Error('LIVE_PATH is not configured');
  if (options.streamId == null || options.streamId === '') {
    throw new Error('streamId is required for live file paths');
  }
  return path.join(livePath, options.tenantId, options.streamId, `${options.streamId}.mp4`);
}

/**
 * Gets the HLS directory path for an archived VOD.
 * Path: {VOD_PATH}/{tenantId}/{vodId}/hls
 */
export function getVodHlsDirPath(options: VodPathOptions): string {
  const vodPath = getVodPath();
  if (vodPath == null) throw new Error('VOD_PATH is not configured');
  return path.join(vodPath, options.tenantId, options.vodId, 'hls');
}

/**
 * Checks if HLS segments exist in the final destination directory.
 * Returns true only if both the m3u8 playlist and segment files are present.
 */
export async function hlsSegmentsExist(tenantId: string, vodId: string): Promise<boolean> {
  const vodPath = getVodPath();
  if (vodPath == null) return false;

  const hlsDir = path.join(vodPath, tenantId, vodId, 'hls');
  const m3u8Path = path.join(hlsDir, `${vodId}.m3u8`);

  const m3u8Exists = await fileExists(m3u8Path);
  if (!m3u8Exists) return false;

  try {
    const entries = await fsPromises.readdir(hlsDir, { withFileTypes: true });
    return entries.some((entry) => {
      const name = entry.name;
      if (!entry.isFile()) return false;
      if (name === `${vodId}.m3u8`) return false;
      return name.endsWith('.ts') || name.endsWith('.mp4');
    });
  } catch {
    return false;
  }
}

/**
 * Returns only the filename component of a path for safe logging.
 * Strips directory components to prevent leaking server directory structure.
 */
export function sanitizePathForLog(filePath: string): string {
  return path.basename(filePath);
}
