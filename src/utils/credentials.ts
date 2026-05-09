import { getBaseConfig } from '../config/env.js';

/**
 * Get the shared Twitch app credentials from environment variables.
 * Throws if TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET is not configured.
 */
export function getTwitchAppCredentials(): { clientId: string; clientSecret: string } {
  const cfg = getBaseConfig();
  if (cfg.TWITCH_CLIENT_ID == null || cfg.TWITCH_CLIENT_ID === '' || cfg.TWITCH_CLIENT_SECRET == null || cfg.TWITCH_CLIENT_SECRET === '') {
    throw new Error(
      'Twitch app credentials not configured. Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in your environment.'
    );
  }
  return {
    clientId: cfg.TWITCH_CLIENT_ID,
    clientSecret: cfg.TWITCH_CLIENT_SECRET,
  };
}
