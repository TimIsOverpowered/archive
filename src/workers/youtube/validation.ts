import { YouTube } from '../../constants.js';

/**
 * Validates and returns effective YouTube split duration.
 * Ensures duration doesn't exceed YouTube's maximum allowed video length.
 */
export function getEffectiveSplitDuration(configuredDuration: number | null | undefined): number {
  if (configuredDuration == null || configuredDuration <= 0) return YouTube.MAX_DURATION;
  if (configuredDuration > YouTube.MAX_DURATION) return YouTube.MAX_DURATION;
  return configuredDuration;
}
