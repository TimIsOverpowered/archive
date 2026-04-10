import path from 'path';
import fsPromises from 'fs/promises';
import { extractErrorDetails } from './error.js';
import { childLogger } from './logger.js';

const log = childLogger({ module: 'path' });

/**
 * Normalizes a file path for cross-platform compatibility.
 * Converts platform-specific separators and resolves relative paths.
 */
export function normalizePath(basePath?: string): string | undefined {
  if (!basePath) return basePath;

  const normalized = path.normalize(basePath);

  return normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) ? normalized : path.resolve(normalized);
}

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

import { getTenantConfig } from '../config/loader.js';

export interface VodFilePathOptions {
  tenantId: string;
  vodId: string;
}

export interface VodDirPathOptions {
  tenantId: string;
  vodId: string;
}

export interface LiveFilePathOptions {
  tenantId: string;
  streamId: string;
}

export interface LiveDirPathOptions {
  tenantId: string;
  streamId: string;
}

/**
 * Gets the file path for an archived VOD.
 * Path: {vodPath}/{tenantId}/{vodId}.mp4
 */
export function getVodFilePath(options: VodFilePathOptions): string {
  const { tenantId, vodId } = options;
  const config = getTenantConfig(tenantId);

  if (!config?.settings.vodPath) {
    throw new Error(`VOD path not configured for tenant ${tenantId}`);
  }

  return path.join(config.settings.vodPath, tenantId, `${vodId}.mp4`);
}

/**
 * Gets the directory path for an archived VOD.
 * Path: {vodPath}/{tenantId}/{vodId}
 */
export function getVodDirPath(options: VodDirPathOptions): string {
  const { tenantId, vodId } = options;
  const config = getTenantConfig(tenantId);

  if (!config?.settings.vodPath) {
    throw new Error(`VOD path not configured for tenant ${tenantId}`);
  }

  return path.join(config.settings.vodPath, tenantId, vodId);
}

/**
 * Gets the file path for a live VOD.
 * Path: {livePath}/{tenantId}/{streamId}/{streamId}.mp4
 */
export function getLiveFilePath(options: LiveFilePathOptions): string {
  const { tenantId, streamId } = options;
  const config = getTenantConfig(tenantId);

  if (!config?.settings.livePath) {
    throw new Error(`Live path not configured for tenant ${tenantId}`);
  }

  return path.join(config.settings.livePath, tenantId, streamId, `${streamId}.mp4`);
}

/**
 * Gets the directory path for a live VOD.
 * Path: {livePath}/{tenantId}/{streamId}
 */
export function getLiveDirPath(options: LiveDirPathOptions): string {
  const { tenantId, streamId } = options;
  const config = getTenantConfig(tenantId);

  if (!config?.settings.livePath) {
    throw new Error(`Live path not configured for tenant ${tenantId}`);
  }

  return path.join(config.settings.livePath, tenantId, streamId);
}
