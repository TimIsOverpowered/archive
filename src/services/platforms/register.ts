import { registerStrategy } from './strategy.js';
import type { PlatformStrategy } from './strategy.js';
import { PLATFORM_VALUES, type Platform } from '../../types/platforms.js';
import { strategy as twitchStrategy } from '../twitch/strategy.js';
import { strategy as kickStrategy } from '../kick/strategy.js';

const strategyMap: Record<Platform, PlatformStrategy> = {
  twitch: twitchStrategy,
  kick: kickStrategy,
};

/**
 * Register all platform strategies at application startup.
 * Maps each platform identifier to its implementation.
 */
export function registerPlatformStrategies(): void {
  for (const platform of PLATFORM_VALUES) {
    registerStrategy(platform, strategyMap[platform]);
  }
}
