import bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { getMetaClient } from '../db/meta-client.js';
import type { SelectableAdmins, InsertableAdmins, UpdateableAdmins } from '../db/meta-types.js';

const adminSelect = ['id', 'username', 'created_at'] as const;
const adminAuthSelect = [...adminSelect, 'api_key_hash'] as const;

type PublicAdmin = Pick<SelectableAdmins, 'id' | 'username' | 'created_at'>;

/**
 * Generate a new API key for an admin.
 * Format: archive_<username>_<random> — the username segment enables fast single-row lookup.
 */
export function generateApiKey(username: string): string {
  const random = randomBytes(32).toString('base64url');
  return `archive_${username}_${random}`;
}

/**
 * Look up an admin by API key. Extracts the username from the key for a targeted single-row query,
 * then verifies with bcrypt. Returns undefined if the key is invalid or doesn't match any admin.
 */
export async function findAdminByApiKey(apiKey: string): Promise<SelectableAdmins | undefined> {
  if (apiKey == null || apiKey === '' || !apiKey.startsWith('archive_')) return;

  const parts = apiKey.split('_');
  const username = parts[1];
  if (username == null || username === '') return;

  const admin = await getMetaClient()
    .selectFrom('admins')
    .select(adminAuthSelect)
    .where('username', '=', username)
    .executeTakeFirst();

  if (!admin) return;

  return (await bcrypt.compare(apiKey, admin.api_key_hash)) ? admin : undefined;
}

/** Look up an admin by username, excluding sensitive fields. */
export async function findAdminByUsername(username: string): Promise<PublicAdmin | undefined> {
  return getMetaClient().selectFrom('admins').select(adminSelect).where('username', '=', username).executeTakeFirst();
}

/** Create a new admin account, hashing the API key if provided. */
export async function createAdmin(data: InsertableAdmins): Promise<PublicAdmin> {
  return getMetaClient().insertInto('admins').values(data).returning(adminSelect).executeTakeFirstOrThrow();
}

/** Update an existing admin account by username. */
export async function updateAdmin(username: string, data: Partial<InsertableAdmins>): Promise<PublicAdmin | undefined> {
  return getMetaClient()
    .updateTable('admins')
    .set(data as UpdateableAdmins)
    .where('username', '=', username)
    .returning(adminSelect)
    .executeTakeFirst();
}
