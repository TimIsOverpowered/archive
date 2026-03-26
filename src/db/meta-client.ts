import { PrismaClient } from '../../prisma/generated/meta';

const globalForPrisma = globalThis as unknown as { prismaMeta: PrismaClient | undefined };

export const metaClient = globalForPrisma.prismaMeta || new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prismaMeta = metaClient;
