import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import { getLogger } from '../../utils/logger.js';
import type { MetaDB } from '../meta-types.js';

const MIGRATIONS_DIR = resolve(import.meta.dirname, '..', '..', 'scripts', 'migrations');

interface MigrationFile {
  name: string;
  sql: string;
}

/**
 * Split SQL text into individual statements, respecting:
 * - Dollar-quoted strings ($$ ... $$, $tag$ ... $tag$)
 * - Single-quoted strings (' ... ')
 * - Line comments (--)
 * - Block comments (slash-star ... star-slash)
 * - Semicolons inside the above are NOT treated as statement separators.
 */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;

  while (i < sql.length) {
    const char = sql[i];

    // Dollar-quoted string: $$ ... $$ or $tag$ ... $tag$
    if (char === '$') {
      const rest = sql.slice(i);
      const match = rest.match(/^\$(\w*)\$/);
      if (match) {
        const tag = match[1];
        const closing = tag !== undefined && tag !== '' ? `$${tag}$` : '$$';
        const endIdx = sql.indexOf(closing, i + closing.length);
        if (endIdx !== -1) {
          current += sql.slice(i, endIdx + closing.length);
          i = endIdx + closing.length;
          continue;
        }
      }
      current += char;
      i++;
      continue;
    }

    // Single-quoted string
    if (char === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          current += "''";
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          current += sql[i];
          i++;
        }
      }
      continue;
    }

    // Line comment
    if (char === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') {
        current += sql[i];
        i++;
      }
      continue;
    }

    // Block comment
    if (char === '/' && sql[i + 1] === '*') {
      current += '/*';
      i += 2;
      while (i < sql.length) {
        if (sql[i] === '*' && sql[i + 1] === '/') {
          current += '*/';
          i += 2;
          break;
        }
        current += sql[i];
        i++;
      }
      continue;
    }

    // Semicolon — potential statement separator
    if (char === ';') {
      const trimmed = current.trim();
      if (trimmed !== '') {
        statements.push(trimmed);
      }
      current = '';
      i++;
      continue;
    }

    current += char;
    i++;
  }

  const remaining = current.trim();
  if (remaining !== '') {
    statements.push(remaining);
  }

  return statements;
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
      const statements = splitSqlStatements(migration.sql);
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
