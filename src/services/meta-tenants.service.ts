import { getMetaClient } from '../db/meta-client.js';
import type { InsertableTenants, TenantResult, UpdateableTenants } from '../db/meta-types.js';

const tenantSelect = [
  'id',
  'display_name as displayName',
  'twitch',
  'youtube',
  'kick',
  'database_url as databaseUrl',
  'settings',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

export async function getAllTenants(): Promise<TenantResult[]> {
  return getMetaClient().selectFrom('tenants').select(tenantSelect).execute();
}

export async function getTenantById(id: string): Promise<TenantResult | undefined> {
  return getMetaClient().selectFrom('tenants').select(tenantSelect).where('id', '=', id).executeTakeFirst();
}

export async function findTenantFirst(where: Record<string, unknown>): Promise<TenantResult | undefined> {
  let query = getMetaClient().selectFrom('tenants').select(tenantSelect);
  for (const [key, value] of Object.entries(where)) {
    query = query.where(key as any, '=', value as any);
  }
  return await query.executeTakeFirst();
}

export async function createTenant(data: InsertableTenants): Promise<TenantResult> {
  return getMetaClient().insertInto('tenants').values(data).returning(tenantSelect).executeTakeFirstOrThrow();
}

export async function updateTenant(id: string, data: Partial<InsertableTenants>): Promise<TenantResult | undefined> {
  return getMetaClient()
    .updateTable('tenants')
    .set(data as UpdateableTenants)
    .where('id', '=', id)
    .returning(tenantSelect)
    .executeTakeFirst();
}

export async function deleteTenant(id: string): Promise<void> {
  await getMetaClient().deleteFrom('tenants').where('id', '=', id).execute();
}
