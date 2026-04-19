// eslint-disable-next-line import-x/extensions
import { PrismaClient } from '../../prisma/generated/meta';
import { PrismaPg } from '@prisma/adapter-pg';
import { getLogger } from '../utils/logger.js';
import { getBaseConfig } from '../config/env.js';

const globalForPrisma = globalThis as unknown as { prismaMeta: PrismaClient | undefined };

let _metaClient: PrismaClient | null = null;

/**
 * Initialize the meta database client. Must be called before getMetaClient().
 * Call from entry points (API config plugin or workers bootstrap) before
 * any code that reads from the meta database.
 */
export async function initMetaClient(): Promise<PrismaClient> {
  if (_metaClient) return _metaClient;

  const url = getBaseConfig().META_DATABASE_URL;

  if (globalForPrisma.prismaMeta) {
    _metaClient = globalForPrisma.prismaMeta;
    return _metaClient;
  }

  const adapter = new PrismaPg({ connectionString: url });
  const client = new PrismaClient({ adapter });
  await client.$connect();

  _metaClient = client;
  if (getBaseConfig().NODE_ENV !== 'production') globalForPrisma.prismaMeta = client;

  getLogger().info('[meta-client] Initialized');
  return _metaClient;
}

/**
 * Get the initialized meta client. Throws if initMetaClient() was never called.
 */
export function getMetaClient(): PrismaClient {
  if (!_metaClient) throw new Error('metaClient not initialized. Call initMetaClient() first.');
  return _metaClient;
}
