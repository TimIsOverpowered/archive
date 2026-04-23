import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import type { MetaDB } from './meta-types.js';
import { getLogger } from '../utils/logger.js';
import { getBaseConfig } from '../config/env.js';
import { extractDatabaseName } from '../utils/formatting.js';
import { buildPgBouncerUrl } from './utils.js';
import { DB_STATEMENT_TIMEOUT_MS } from '../constants.js';

const globalForMeta = globalThis as unknown as { metaDb: Kysely<MetaDB> | undefined };

let _metaDb: Kysely<MetaDB> | null = null;

/**
 * Initialize the meta database client. Must be called before getMetaClient().
 * Call from entry points (API config plugin or workers bootstrap) before
 * any code that reads from the meta database.
 */
export async function initMetaClient(): Promise<Kysely<MetaDB>> {
  if (_metaDb) return _metaDb;

  // In development, share across hot-reload boundaries via globalThis.
  // This guard must match the storage guard below to avoid stale reads.
  if (getBaseConfig().NODE_ENV !== 'production' && globalForMeta.metaDb) {
    _metaDb = globalForMeta.metaDb;
    return _metaDb;
  }

  const pgbouncerUrl = getBaseConfig().PGBOUNCER_URL;
  const metaDbUrl = getBaseConfig().META_DATABASE_URL;
  const metaDbName = extractDatabaseName(metaDbUrl);

  const url = buildPgBouncerUrl(pgbouncerUrl, metaDbName);

  const pool = new Pool({ connectionString: url, statement_timeout: DB_STATEMENT_TIMEOUT_MS });
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
  if (getBaseConfig().NODE_ENV !== 'production') {
    globalForMeta.metaDb = undefined;
  }
  getLogger().info('[meta-client] Closed');
}
