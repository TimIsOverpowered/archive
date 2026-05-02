import { Job } from 'bullmq';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { initRichAlert } from '../../utils/discord-alerts.js';
import { configService } from '../../config/tenant-config.js';
import { ensureClient } from '../../db/streamer-client.js';
import type { TenantConfig } from '../../config/types.js';
import type { Kysely } from 'kysely';
import type { StreamerDB } from '../../db/streamer-types.js';
import { TenantNotFoundError, ConfigNotConfiguredError } from '../../utils/domain-errors.js';
import type { Platform } from '../../types/platforms.js';
import type { BaseWorkerContext } from '../types.js';
import type { RichEmbedData } from '../../utils/discord-alerts.js';

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

export type ContextBuilder<TExtra> = (
  config: TenantConfig,
  db: Kysely<StreamerDB>
) => Promise<{ extra: TExtra; alertInitArgs: unknown[] }> | { extra: TExtra; alertInitArgs: unknown[] };

export async function buildWorkerContext<
  T extends BaseWorkerContext,
  TExtra extends Record<string, unknown> = Record<string, unknown>,
>(
  job: Job,
  tenantId: string,
  dbId: number,
  vodId: string,
  platform: Platform,
  configBuilder: ContextBuilder<TExtra>,
  alertFactory: () => unknown
): Promise<T> {
  const log = createAutoLogger(String(tenantId));

  log.info({ component: 'worker', jobId: job.id, dbId, vodId, platform, tenantId }, 'Starting job');
  await job.updateProgress(0);

  const { config, db } = await getJobContext(tenantId);

  const { extra, alertInitArgs } = await configBuilder(config, db);
  const alerts = alertFactory();
  const messageId = await initRichAlert(
    (alerts as { init: (...args: unknown[]) => RichEmbedData }).init(...alertInitArgs)
  );

  if (messageId == null) {
    throw new Error('Failed to initialize alert');
  }

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
  } as unknown as T;
}
