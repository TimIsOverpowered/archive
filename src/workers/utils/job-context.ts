import { getTenantConfig } from '../../config/loader.js';
import { ensureClient } from '../../db/streamer-client.js';
import type { TenantConfig } from '../../config/types.js';
import type { Kysely } from 'kysely';
import type { StreamerDB } from '../../db/streamer-types.js';

export interface JobContext {
  config: TenantConfig;
  db: Kysely<StreamerDB>;
  tenantId: string;
}

export async function getJobContext(tenantId: string): Promise<JobContext> {
  const config = getTenantConfig(tenantId);

  if (!config) {
    throw new Error(`Config not found for tenant ${tenantId}`);
  }

  if (!config.settings.vodPath) {
    throw new Error(`VOD path not configured for ${tenantId}`);
  }

  const db = await ensureClient(tenantId, config);

  return { config, db, tenantId };
}
