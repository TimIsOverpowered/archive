import { getTenantConfig } from '../../config/loader.js';
import { ensureClient } from '../../db/client.js';
import type { TenantConfig } from '../../config/types.js';
import type { PrismaClient } from '../../../generated/streamer/client.js';

export interface JobContext {
  config: TenantConfig;
  db: PrismaClient;
  tenantId: string;
}

export async function getJobContext(tenantId: string): Promise<JobContext> {
  const config = getTenantConfig(tenantId);

  if (!config) {
    throw new Error(`Config not found for tenant ${tenantId}`);
  }

  const db = await ensureClient(tenantId, config);

  return { config, db, tenantId };
}
