import { getMetaClient } from '../db/meta-client.js';
import type { InsertableTenants, TenantResult, UpdateableTenants } from '../db/meta-types.js';

const tenantSelect = [
  'id',
  'display_name as displayName',
  'twitch',
  'youtube',
  'kick',
  'database_name as databaseName',
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
