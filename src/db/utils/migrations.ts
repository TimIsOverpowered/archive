import { readFileSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { sql, type Kysely } from 'kysely';
import { getLogger } from '../../utils/logger.js';
import type { MetaDB } from '../meta-types.js';

const MIGRATIONS_DIR = resolve(import.meta.dirname, '..', '..', 'scripts', 'migrations');

interface MigrationFile {
  name: string;
  sql: string;
}

function loadMigrations(): MigrationFile[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  return files.map((name) => ({
    name,
    sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf-8'),
  }));
}

async function ensureMigrationsTable(db: Kysely<MetaDB>): Promise<void> {
  await db.schema
    .createTable('migrations')
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull().unique())
    .addColumn('applied_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .ifNotExists()
    .execute();
}

export async function runMigrations(db: Kysely<MetaDB>): Promise<void> {
  const log = getLogger();
  const migrations = loadMigrations();

  await ensureMigrationsTable(db);

  for (const migration of migrations) {
    const exists = await db.selectFrom('migrations').select('id').where('name', '=', migration.name).executeTakeFirst();

    if (exists) {
      log.debug({ migration: migration.name }, 'Migration already applied, skipping');
      continue;
    }

    log.info({ migration: migration.name }, 'Applying migration');
    await db.transaction().execute(async (trx) => {
      const statements = migration.sql.split(';').filter((s) => s.trim() !== '');
      for (const statement of statements) {
        await sql`${sql.raw(statement)}`.execute(trx);
      }
      await trx.insertInto('migrations').values({ name: migration.name }).execute();
    });
    log.info({ migration: migration.name }, 'Migration applied successfully');
  }
}

export async function getAppliedMigrations(db: Kysely<MetaDB>): Promise<string[]> {
  const rows = await db.selectFrom('migrations').select('name').orderBy('applied_at', 'asc').execute();

  return rows.map((r) => r.name);
}
