import { Job } from 'bullmq';
import type { Kysely } from 'kysely';
import { configService } from '../../config/tenant-config.js';
import type { TenantConfig } from '../../config/types.js';
import { ensureClient } from '../../db/streamer-client.js';
import type { StreamerDB } from '../../db/streamer-types.js';
import type { Platform } from '../../types/platforms.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { initRichAlert } from '../../utils/discord-alerts.js';
import type { RichEmbedData } from '../../utils/discord-alerts.js';
import { TenantNotFoundError, ConfigNotConfiguredError } from '../../utils/domain-errors.js';
import type { BaseWorkerContext } from '../types.js';

export interface JobContext {
  config: TenantConfig;
  db: Kysely<StreamerDB>;
  tenantId: string;
}

export async function getJobContext(tenantId: string): Promise<JobContext> {
  const config = configService.get(tenantId);

  if (!config) {
    throw new TenantNotFoundError(tenantId);
  }

  if (config.settings.vodPath == null) {
    throw new ConfigNotConfiguredError(`VOD path for tenant ${tenantId}`);
  }

  const db = await ensureClient(tenantId, config);

  return { config, db, tenantId };
}

export type ContextBuilder<TExtra, TAlertArgs extends unknown[] = unknown[]> = (
  config: TenantConfig,
  db: Kysely<StreamerDB>
) => Promise<{ extra: TExtra; alertInitArgs: TAlertArgs }> | { extra: TExtra; alertInitArgs: TAlertArgs };

export async function buildWorkerContext<TExtra extends Record<string, unknown>, TAlerts, TAlertArgs extends unknown[]>(
  job: Job,
  tenantId: string,
  dbId: number,
  vodId: string,
  platform: Platform,
  extraBuilder: ContextBuilder<TExtra, TAlertArgs>,
  alertFactory: () => TAlerts
): Promise<BaseWorkerContext & TExtra & { alerts: TAlerts; messageId: string | null }> {
  const log = createAutoLogger(String(tenantId));

  log.info({ component: 'worker', jobId: job.id, dbId, vodId, platform, tenantId }, 'Starting job');
  await job.updateProgress(0);

  const { config, db } = await getJobContext(tenantId);

  const { extra, alertInitArgs } = await extraBuilder(config, db);
  const alerts = alertFactory();
  const messageId = await initRichAlert(
    (alerts as { init: (...args: TAlertArgs) => RichEmbedData }).init(...alertInitArgs)
  ).catch(() => null);

  return {
    config,
    db,
    tenantId,
    log,
    dbId,
    vodId,
    platform,
    ...extra,
    alerts,
    messageId,
  };
}
