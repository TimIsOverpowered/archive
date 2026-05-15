import type { TenantConfig } from '../../config/types.js';

export function calcLiveConcurrency(configs: TenantConfig[], headroom: number, minConcurrency: number): number {
  const active = configs.filter(
    (c) => c.settings.vodDownload === true && (c.twitch?.enabled ?? c.kick?.enabled) === true
  ).length;
  return Math.max(active * 2 * headroom, minConcurrency);
}
