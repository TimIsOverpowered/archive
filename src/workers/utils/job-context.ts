import { configService } from '../../config/tenant-config.js';
import { ensureClient } from '../../db/streamer-client.js';
import type { TenantConfig } from '../../config/types.js';
import type { Kysely } from 'kysely';
import type { StreamerDB } from '../../db/streamer-types.js';
import { TenantNotFoundError, ConfigNotConfiguredError } from '../../utils/domain-errors.js';

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

  if (!config.settings.vodPath) {
    throw new ConfigNotConfiguredError(`VOD path for tenant ${tenantId}`);
  }

  const db = await ensureClient(tenantId, config);

  return { config, db, tenantId };
}
