// eslint-disable-next-line import-x/extensions
import { PrismaClient } from '../../prisma/generated/meta';
import { PrismaPg } from '@prisma/adapter-pg';
import { logger } from '../utils/logger.js';

const globalForPrisma = globalThis as unknown as { prismaMeta: PrismaClient | undefined };

if (!process.env.META_DATABASE_URL) {
  if (process.argv[1]?.includes('workers')) {
    logger.warn('[meta-client] META_DATABASE_URL not set. Skipping meta client initialization.');
    process.exit(0);
  } else {
    throw new Error('META_DATABASE_URL environment variable is required');
  }
}

const adapter = new PrismaPg({
  connectionString: process.env.META_DATABASE_URL,
});

export const metaClient = globalForPrisma.prismaMeta || new PrismaClient({ adapter });
if (process.env.NODE_ENV !== 'production') globalForPrisma.prismaMeta = metaClient;
