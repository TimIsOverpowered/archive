import { getBaseConfig } from '../../config/env.js';

export function isAlertsEnabled(): boolean {
  return getBaseConfig().DISCORD_ALERTS_ENABLED;
}
