import { PrismaClient } from '../../prisma/generated/meta';
import { PrismaPg } from '@prisma/adapter-pg';

const globalForPrisma = globalThis as unknown as { prismaMeta: PrismaClient | undefined };

if (!process.env.META_DATABASE_URL) {
  throw new Error('META_DATABASE_URL environment variable is required');
}

const adapter = new PrismaPg({
  connectionString: process.env.META_DATABASE_URL,
});

export const metaClient = globalForPrisma.prismaMeta || new PrismaClient({ adapter });
if (process.env.NODE_ENV !== 'production') globalForPrisma.prismaMeta = metaClient;
