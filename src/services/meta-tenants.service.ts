import { getMetaClient } from '../db/meta-client.js';
import type { InsertableTenants, SelectableTenants, UpdateableTenants } from '../db/meta-types.js';
import { encryptObject, encryptScalar } from '../utils/encryption.js';

const tenantColumns = [
  'id',
  'display_name',
  'twitch',
  'youtube',
  'kick',
  'database_name',
  'settings',
  'created_at',
  'updated_at',
] as const;

function encryptYoutubeFields(youtube: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (youtube == null) return undefined;

  const result = { ...youtube };

  if (result.auth != null && typeof result.auth === 'object' && !Array.isArray(result.auth)) {
    result.auth = encryptObject(result.auth);
  }

  if (typeof result.apiKey === 'string' && result.apiKey !== '') {
    result.apiKey = encryptScalar(result.apiKey);
  }

  return result;
}

function encryptYoutubeInData(data: InsertableTenants): InsertableTenants;
function encryptYoutubeInData(data: Partial<InsertableTenants>): Partial<InsertableTenants>;
function encryptYoutubeInData(data: Partial<InsertableTenants>): Partial<InsertableTenants> {
  const encrypted = { ...data };

  if (encrypted.youtube != null && typeof encrypted.youtube === 'object') {
    if (typeof encrypted.youtube === 'string') {
      try {
        const parsed = JSON.parse(encrypted.youtube) as Record<string, unknown>;
        encrypted.youtube = JSON.stringify(encryptYoutubeFields(parsed));
      } catch {
        // not valid JSON, leave as-is
      }
    } else {
      encrypted.youtube = JSON.stringify(encryptYoutubeFields(encrypted.youtube));
    }
  }

  return encrypted;
}

function stripEncryptedFields(tenant: SelectableTenants): SelectableTenants {
  const youtube = tenant.youtube;
  if (youtube != null) {
    const { auth: _auth, apiKey: _apiKey, ...safeYoutube } = youtube;
    return { ...tenant, youtube: Object.keys(safeYoutube).length > 0 ? safeYoutube : null };
  }
  return tenant;
}

/** Retrieve all tenants from the metadata database (encrypted fields stripped for API responses). */
export async function getAllTenants(): Promise<SelectableTenants[]> {
  const tenants = await getMetaClient().selectFrom('tenants').selectAll().execute();
  return tenants.map(stripEncryptedFields);
}

/** Retrieve all tenants from the metadata database without stripping encrypted fields. */
export async function getAllTenantsRaw(): Promise<SelectableTenants[]> {
  const tenants = await getMetaClient().selectFrom('tenants').selectAll().execute();
  return tenants;
}

/** Look up a tenant by ID from the metadata database (encrypted fields stripped for API responses). */
export async function getTenantById(id: string): Promise<SelectableTenants | undefined> {
  const tenant = await getMetaClient().selectFrom('tenants').selectAll().where('id', '=', id).executeTakeFirst();
  return tenant ? stripEncryptedFields(tenant) : undefined;
}

/** Look up a tenant by ID from the metadata database without stripping encrypted fields. */
export async function getTenantByIdRaw(id: string): Promise<SelectableTenants | undefined> {
  const tenant = await getMetaClient().selectFrom('tenants').selectAll().where('id', '=', id).executeTakeFirst();
  return tenant;
}

/** Create a new tenant record in the metadata database. */
export async function createTenant(data: InsertableTenants): Promise<SelectableTenants> {
  const encrypted = encryptYoutubeInData(data);

  return getMetaClient()
    .insertInto('tenants')
    .values({
      ...encrypted,
      updated_at: new Date(),
    })
    .returning(tenantColumns)
    .executeTakeFirstOrThrow();
}

/** Update an existing tenant record by ID. */
export async function updateTenant(
  id: string,
  data: Partial<InsertableTenants>
): Promise<SelectableTenants | undefined> {
  const encrypted = encryptYoutubeInData(data);

  return getMetaClient()
    .updateTable('tenants')
    .set({ ...encrypted, updated_at: new Date() } as UpdateableTenants)
    .where('id', '=', id)
    .returning(tenantColumns)
    .executeTakeFirst();
}

/** Delete a tenant record by ID. */
export async function deleteTenant(id: string): Promise<void> {
  await getMetaClient().deleteFrom('tenants').where('id', '=', id).execute();
}
