import bcrypt from 'bcrypt';
import { getMetaClient } from '../db/meta-client.js';
import type { SelectableAdmins, InsertableAdmins, UpdateableAdmins } from '../db/meta-types.js';

const BCRYPT_COST = 10;

const adminSelect = ['id', 'username', 'api_key_hash', 'created_at'] as const;

export async function findAdminByApiKey(apiKey: string): Promise<SelectableAdmins | undefined> {
  if (!apiKey || !apiKey.startsWith('archive_')) return;

  const hash = await bcrypt.hash(apiKey, BCRYPT_COST);

  const admin = await getMetaClient()
    .selectFrom('admins')
    .select(adminSelect)
    .where('api_key_hash', '=', hash)
    .executeTakeFirst();

  return admin;
}

export async function findAdminByUsername(username: string): Promise<SelectableAdmins | undefined> {
  return getMetaClient().selectFrom('admins').selectAll().where('username', '=', username).executeTakeFirst();
}

export async function createAdmin(data: InsertableAdmins): Promise<SelectableAdmins> {
  return getMetaClient().insertInto('admins').values(data).returning(adminSelect).executeTakeFirstOrThrow();
}

export async function updateAdmin(
  username: string,
  data: Partial<InsertableAdmins>
): Promise<SelectableAdmins | undefined> {
  return getMetaClient()
    .updateTable('admins')
    .set(data as UpdateableAdmins)
    .where('username', '=', username)
    .returning(adminSelect)
    .executeTakeFirst();
}
