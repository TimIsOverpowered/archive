import bcrypt from 'bcrypt';
import { getMetaClient } from '../db/meta-client.js';
import type { SelectableAdmins, InsertableAdmins, UpdateableAdmins } from '../db/meta-types.js';

const adminSelect = ['id', 'username', 'created_at'] as const;
const adminAuthSelect = [...adminSelect, 'api_key_hash'] as const;

type PublicAdmin = Pick<SelectableAdmins, 'id' | 'username' | 'created_at'>;

export async function findAdminByApiKey(apiKey: string): Promise<SelectableAdmins | undefined> {
  if (!apiKey || !apiKey.startsWith('archive_')) return;

  const admins = await getMetaClient().selectFrom('admins').select(adminAuthSelect).execute();

  for (const admin of admins) {
    if (await bcrypt.compare(apiKey, admin.api_key_hash)) {
      return admin;
    }
  }

  return undefined;
}

export async function findAdminByUsername(username: string): Promise<PublicAdmin | undefined> {
  return getMetaClient().selectFrom('admins').select(adminSelect).where('username', '=', username).executeTakeFirst();
}

export async function createAdmin(data: InsertableAdmins): Promise<PublicAdmin> {
  return getMetaClient().insertInto('admins').values(data).returning(adminSelect).executeTakeFirstOrThrow();
}

export async function updateAdmin(username: string, data: Partial<InsertableAdmins>): Promise<PublicAdmin | undefined> {
  return getMetaClient()
    .updateTable('admins')
    .set(data as UpdateableAdmins)
    .where('username', '=', username)
    .returning(adminSelect)
    .executeTakeFirst();
}
