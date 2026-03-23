import { PrismaClient } from '../../prisma/generated/meta';

const globalForPrisma = globalThis as unknown as { prismaMeta: PrismaClient | undefined };

export const metaClient = (globalForPrisma.prismaMeta || new PrismaClient({ datasources: { db: { url: process.env.META_DATABASE_URL! } } }));
if (process.env.NODE_ENV !== 'production') globalForPrisma.prismaMeta = metaClient;
