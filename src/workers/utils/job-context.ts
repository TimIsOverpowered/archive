import { configService } from '../../config/tenant-config.ts';
import type { TenantConfig } from '../../config/types.ts';
import { ensureClient } from '../../db/streamer-client.ts';
import type { StreamerDB } from '../../db/streamer-types.ts';
import { TenantNotFoundError } from '../../utils/domain-errors.ts';

export interface JobContext {
  config: TenantConfig;
  db: import('kysely').Kysely<StreamerDB>;
  tenantId: string;
}

export async function getJobContext(tenantId: string): Promise<JobContext> {
  const config = await configService.get(tenantId);

  if (!config) {
    throw new TenantNotFoundError(tenantId);
  }

  const db = await ensureClient(tenantId, config);

  return { config, db, tenantId };
}
