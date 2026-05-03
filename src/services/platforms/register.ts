import { extractErrorDetails } from '../../utils/error.js';
import { getLogger } from '../../utils/logger.js';
import { registerStrategy } from './strategy.js';
import type { PlatformStrategy } from './strategy.js';
import { PLATFORM_VALUES, type Platform } from '../../types/platforms.js';
import { strategy as twitchStrategy } from '../twitch/strategy.js';
import { strategy as kickStrategy } from '../kick/strategy.js';

const strategyMap = {
  twitch: twitchStrategy,
  kick: kickStrategy,
} satisfies Record<Platform, PlatformStrategy>;

/**
 * Register all platform strategies at application startup.
 * Maps each platform identifier to its implementation.
 */
export function registerPlatformStrategies(): void {
  for (const platform of PLATFORM_VALUES) {
    try {
      registerStrategy(platform, strategyMap[platform]);
    } catch (err) {
      getLogger().fatal({ platform, error: extractErrorDetails(err) }, 'Failed to register strategy');
      throw err;
    }
  }
}
