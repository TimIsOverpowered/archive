import { PLATFORM_VALUES, type Platform } from '../../types/platforms.ts';
import { extractErrorDetails } from '../../utils/error.ts';
import { getLogger } from '../../utils/logger.ts';
import { strategy as kickStrategy } from '../kick/strategy.ts';
import { strategy as twitchStrategy } from '../twitch/strategy.ts';
import type { PlatformStrategy } from './strategy.ts';
import { registerStrategy } from './strategy.ts';

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
