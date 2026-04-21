import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import type { MetaDB } from './meta-types.js';
import { getLogger } from '../utils/logger.js';
import { getBaseConfig } from '../config/env.js';
import { extractDatabaseName } from '../utils/formatting.js';

const globalForMeta = globalThis as unknown as { metaDb: Kysely<MetaDB> | undefined };

let _metaDb: Kysely<MetaDB> | null = null;

/**
 * Initialize the meta database client. Must be called before getMetaClient().
 * Call from entry points (API config plugin or workers bootstrap) before
 * any code that reads from the meta database.
 */
export async function initMetaClient(): Promise<Kysely<MetaDB>> {
  if (_metaDb) return _metaDb;

  const pgbouncerUrl = getBaseConfig().PGBOUNCER_URL;
  const metaDbUrl = getBaseConfig().META_DATABASE_URL;

  if (globalForMeta.metaDb) {
    _metaDb = globalForMeta.metaDb;
    return _metaDb;
  }

  const metaDbName = extractDatabaseName(metaDbUrl);

  const url = new URL(pgbouncerUrl);
  url.pathname = `/${metaDbName}`;

  const pool = new Pool({ connectionString: url.toString() });
  const dialect = new PostgresDialect({ pool });
  const db = new Kysely<MetaDB>({ dialect });

  _metaDb = db;
  if (getBaseConfig().NODE_ENV !== 'production') globalForMeta.metaDb = db;

  getLogger().info('[meta-client] Initialized (Kysely)');
  return _metaDb;
}

/**
 * Get the initialized meta client. Throws if initMetaClient() was never called.
 */
export function getMetaClient(): Kysely<MetaDB> {
  if (!_metaDb) throw new Error('metaClient not initialized. Call initMetaClient() first.');
  return _metaDb;
}

export async function closeMetaClient(): Promise<void> {
  if (!_metaDb) return;
  await _metaDb.destroy();
  _metaDb = null;
  getLogger().info('[meta-client] Closed');
}
