import { getMetaClient } from '../db/meta-client.js';
import type { InsertableTenants, TenantResult, UpdateableTenants, SelectableTenants } from '../db/meta-types.js';

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

/** Retrieve all tenants from the metadata database. */
export async function getAllTenants(): Promise<TenantResult[]> {
  return getMetaClient().selectFrom('tenants').select(tenantSelect).execute();
}

/** Look up a tenant by ID from the metadata database. */
export async function getTenantById(id: string): Promise<TenantResult | undefined> {
  return getMetaClient().selectFrom('tenants').select(tenantSelect).where('id', '=', id).executeTakeFirst();
}

/** Find a tenant matching the first defined where clause key. */
export async function findTenantFirst(where: Partial<SelectableTenants>): Promise<TenantResult | undefined> {
  let query = getMetaClient().selectFrom('tenants').select(tenantSelect);

  let key: keyof SelectableTenants;
  for (key in where) {
    const value = where[key];
    if (value !== undefined) {
      query = query.where(key, '=', value as never);
    }
  }

  return await query.executeTakeFirst();
}

/** Create a new tenant record in the metadata database. */
export async function createTenant(data: InsertableTenants): Promise<TenantResult> {
  return getMetaClient()
    .insertInto('tenants')
    .values({
      ...data,
      updated_at: new Date(),
    })
    .returning(tenantSelect)
    .executeTakeFirstOrThrow();
}

/** Update an existing tenant record by ID. */
export async function updateTenant(id: string, data: Partial<InsertableTenants>): Promise<TenantResult | undefined> {
  return getMetaClient()
    .updateTable('tenants')
    .set({ ...data, updated_at: new Date() } as UpdateableTenants)
    .where('id', '=', id)
    .returning(tenantSelect)
    .executeTakeFirst();
}

/** Delete a tenant record by ID. */
export async function deleteTenant(id: string): Promise<void> {
  await getMetaClient().deleteFrom('tenants').where('id', '=', id).execute();
}
