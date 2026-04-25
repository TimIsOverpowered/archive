import { YOUTUBE_MAX_DURATION } from '../../constants.js';

/**
 * Validates and returns effective YouTube split duration.
 * Ensures duration doesn't exceed YouTube's maximum allowed video length.
 */
export function getEffectiveSplitDuration(configuredDuration: number | null | undefined): number {
  if (configuredDuration == null || configuredDuration <= 0) return YOUTUBE_MAX_DURATION;
  if (configuredDuration > YOUTUBE_MAX_DURATION) return YOUTUBE_MAX_DURATION;
  return configuredDuration;
}
