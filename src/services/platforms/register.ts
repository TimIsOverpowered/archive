import { registerStrategy } from './strategy.js';
import { twitchStrategy } from './twitch-strategy.js';
import { kickStrategy } from './kick-strategy.js';
import { PLATFORMS } from '../../types/platforms.js';

export function registerPlatformStrategies(): void {
  registerStrategy(PLATFORMS.TWITCH, twitchStrategy);
  registerStrategy(PLATFORMS.KICK, kickStrategy);
}
