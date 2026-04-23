import { Kysely, SqliteDialect } from 'kysely';
import Database from 'better-sqlite3';
import type { StreamerDB } from '../../src/db/streamer-types.js';

export interface MockDbResult<T> {
  db: Kysely<StreamerDB>;
  close: () => void;
}

export function createMockDb(): MockDbResult {
  const sqlite = new Database(':memory:');
  const dialect = new SqliteDialect({ database: sqlite });
  const db = new Kysely<StreamerDB>({ dialect });

  db.schema
    .createTable('vods')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('vod_id', 'varchar', (col) => col.notNull())
    .addColumn('platform', 'varchar', (col) => col.notNull())
    .addColumn('platform_user_id', 'varchar')
    .addColumn('platform_username', 'varchar')
    .addColumn('started_at', 'varchar')
    .addColumn('ended_at', 'varchar')
    .addColumn('duration', 'integer')
    .addColumn('is_live', 'boolean', (col) => col.defaultTo(false))
    .addColumn('created_at', 'varchar', (col) => col.defaultTo(sqlite.fn.currentTimestamp()))
    .addColumn('updated_at', 'varchar')
    .executeIfNotExists();

  db.schema
    .createTable('chat_messages')
    .addColumn('id', 'varchar', (col) => col.primaryKey())
    .addColumn('vod_id', 'integer', (col) => col.references('vods.id'))
    .addColumn('display_name', 'varchar')
    .addColumn('content_offset_seconds', 'integer')
    .addColumn('user_color', 'varchar')
    .addColumn('created_at', 'varchar')
    .addColumn('message', 'text')
    .addColumn('user_badges', 'text')
    .executeIfNotExists();

  db.schema
    .createTable('vod_uploads')
    .addColumn('vod_id', 'integer', (col) => col.references('vods.id'))
    .addColumn('upload_id', 'varchar')
    .addColumn('type', 'varchar')
    .addColumn('duration', 'integer')
    .addColumn('part', 'integer')
    .addColumn('status', 'varchar')
    .executeIfNotExists();

  db.schema
    .createTable('chapters')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('vod_id', 'integer', (col) => col.references('vods.id'))
    .addColumn('name', 'varchar')
    .addColumn('start_time', 'integer')
    .addColumn('end_time', 'integer')
    .addColumn('game_id', 'varchar')
    .addColumn('game_name', 'varchar')
    .executeIfNotExists();

  return {
    db,
    close: () => {
      db.destroy();
      sqlite.close();
    },
  };
}
