import { PrismaClient } from '../../generated/streamer/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { TenantConfig } from '../config/types';

const clients = new Map<string, PrismaClient>();

export function getClient(tenantId: string): PrismaClient | undefined {
  return clients.get(tenantId);
}

export async function createClient(config: TenantConfig): Promise<PrismaClient> {
  if (clients.has(config.id)) return clients.get(config.id)!;

  const connectionLimit = config.database.connectionLimit || 5;
  const urlWithParams = `${config.database.url}${config.database.url.includes('?') ? '&' : '?'}connection_limit=${connectionLimit}`;

  const adapter = new PrismaPg({ connectionString: urlWithParams });
  const client = new PrismaClient({ adapter });

  await client.$connect();
  clients.set(config.id, client);

  return client;
}

export async function closeClient(tenantId: string): Promise<void> {
  const client = clients.get(tenantId);
  if (client) {
    try {
      await client.$disconnect();
    } catch {}
    clients.delete(tenantId);
  }
}

export async function closeAllClients(): Promise<void> {
  for (const [tenantId, client] of clients.entries()) {
    try {
      await client.$disconnect();
    } catch {}
    clients.delete(tenantId);
  }
}
