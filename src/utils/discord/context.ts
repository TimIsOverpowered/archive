import { getBaseConfig } from '../../config/env.js';

export function isAlertsEnabled(): boolean {
  return getBaseConfig().DISCORD_ALERTS_ENABLED;
}

export interface AlertContext {
  messageId: string | null;
  enabled: boolean;
}

export function createAlertContext(): AlertContext {
  return {
    messageId: null,
    enabled: isAlertsEnabled(),
  };
}
