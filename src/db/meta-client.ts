import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { getBaseConfig } from '../config/env.js';
import { Db } from '../constants.js';
import { extractDatabaseName } from '../utils/formatting.js';
import { getLogger } from '../utils/logger.js';
import type { MetaDB } from './meta-types.js';
import { buildPgBouncerUrl } from './utils/pg-bouncer.js';

// Double-cast pattern: globalThis is `object`-typed, so we cast through `unknown` first
// to avoid type conflicts. This enables sharing the Kysely instance across hot-reload
// boundaries in development while the module-level `_metaDb` guard handles production.
const globalForMeta = globalThis as unknown as { metaDb: Kysely<MetaDB> | undefined };

let _metaDb: Kysely<MetaDB> | null = null;

/**
 * Initialize the meta database client. Must be called before getMetaClient().
 * Call from entry points (API config plugin or workers bootstrap) before
 * any code that reads from the meta database.
 *
 * Note: Synchronous — PgPool defers actual connection until the first query.
 * Callers using `await` are unaffected (await on a non-Thenable is a no-op).
 */
export function initMetaClient(): Kysely<MetaDB> {
  if (_metaDb) return _metaDb;

  const { NODE_ENV, PGBOUNCER_URL, META_DATABASE_URL } = getBaseConfig();

  // In development, share across hot-reload boundaries via globalThis.
  // This guard must match the storage guard below to avoid stale reads.
  if (NODE_ENV !== 'production' && globalForMeta.metaDb) {
    _metaDb = globalForMeta.metaDb;
    return _metaDb;
  }

  const pgbouncerUrl = PGBOUNCER_URL;
  const metaDbUrl = META_DATABASE_URL;
  const metaDbName = extractDatabaseName(metaDbUrl);

  const url = buildPgBouncerUrl(pgbouncerUrl, metaDbName);

  const pool = new Pool({ connectionString: url, statement_timeout: Db.STATEMENT_TIMEOUT_MS });
  const dialect = new PostgresDialect({ pool });
  const db = new Kysely<MetaDB>({ dialect });

  _metaDb = db;
  if (NODE_ENV !== 'production') globalForMeta.metaDb = db;

  getLogger().info({ component: 'meta-client' }, 'Initialized (Kysely)');
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
  getLogger().info({ component: 'meta-client' }, 'Closed');
}
