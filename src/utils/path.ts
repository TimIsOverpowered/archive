import path from 'path';

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
 * Safely joins a base config path with segments for cross-platform compatibility.
 * Handles undefined/empty paths gracefully and filters out empty segments.
 */
export function joinConfigPath(basePath?: string, ...segments: string[]): string {
  if (!basePath) return path.join(...segments);

  const normalizedBase = normalizePath(basePath)!;
  return path.join(normalizedBase, ...segments.filter((s) => s !== ''));
}

/**
 * Ensures consistent file separators in a path for cross-platform usage.
 */
export function ensureConsistentSeparators(filePath: string): string {
  return path.normalize(filePath);
}
