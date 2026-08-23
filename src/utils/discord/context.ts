import { getBaseConfig } from '../../config/env.ts';

export function isAlertsEnabled(): boolean {
  return getBaseConfig().DISCORD_ALERTS_ENABLED;
}
