#!/usr/bin/env node
import 'dotenv/config';
import { PrismaClient } from '../prisma/generated/meta/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { program } from 'commander';
import readline from 'readline';
import path from 'path';
import fs from 'fs';

program
  .requiredOption('--streamer <name>', 'Streamer name (tenant identifier)')
  .requiredOption('--db-url <url>', 'PostgreSQL connection URL for streamer database')
  .option('--dry-run', 'Validate migration without executing, default false')
  .parse(process.argv);

const options = program.opts();

const META_DB_URL = process.env.META_DATABASE_URL;
if (!META_DB_URL) {
  console.error('❌ Missing META_DATABASE_URL environment variable');
  process.exit(1);
}

const adapter = new PrismaPg({ connectionString: META_DB_URL });
const metaClient = new PrismaClient({ adapter });

const parseDuration = (durationStr: string): number => {
  if (!durationStr || durationStr === '00:00:00') return 0;
  const parts = durationStr.split(':').map(Number);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return 0;
};

const confirm = async (question: string): Promise<boolean> => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N]: `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
};

const main = async () => {
  console.log(`\n🚀 Starting migration for streamer: ${options.streamer}`);
  console.log(`Database URL: ${options.dbUrl.replace(/\/\/.*@/, '//***:***@')}`);
  console.log(`Dry run: ${options.dryRun ? 'YES' : 'NO'}\n`);

  try {
    const pg = await import('pg');
    const oldPool = new pg.Pool({ connectionString: options.dbUrl });

    try {
      const vodsResult = await oldPool.query("SELECT COUNT(*) FROM vods WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'vods' AND column_name = 'youtube')");
      const isAlreadyMigrated = vodsResult.rows[0].count > 0;

      if (isAlreadyMigrated) {
        console.log('⚠️  Migration appears to already be completed or partially done');
        console.log('   Check tables: vods, emotes, games, chapters, chat_messages');
        return;
      }

      const oldVodsCount = await oldPool.query('SELECT COUNT(*) FROM vods');
      const oldEmotesCount = await oldPool.query('SELECT COUNT(*) FROM emotes');
      const oldGamesCount = await oldPool.query('SELECT COUNT(*) FROM games');
      const oldLogsCount = await oldPool.query('SELECT COUNT(*) FROM logs');

      console.log('📊 Legacy database row counts:');
      console.log(`   vods: ${oldVodsCount.rows[0].count}`);
      console.log(`   emotes: ${oldEmotesCount.rows[0].count}`);
      console.log(`   games: ${oldGamesCount.rows[0].count}`);
      console.log(`   logs: ${oldLogsCount.rows[0].count}\n`);

      if (options.dryRun) {
        console.log('✅ Dry run validation complete');
        console.log('   Would migrate:', oldVodsCount.rows[0].count, 'VODs');
        console.log('   Would migrate:', oldEmotesCount.rows[0].count, 'emote records');
        console.log('   Would migrate:', oldGamesCount.rows[0].count, 'game records');
        console.log('   Would migrate:', oldLogsCount.rows[0].count, 'chat messages');
        return;
      }

      const proceed = await confirm('Proceed with migration? This will create new tables and migrate data');
      if (!proceed) {
        console.log('❌ Migration cancelled by user');
        process.exit(0);
      }

      const client = await oldPool.connect();
      try {
        await client.query('BEGIN');

        try {
          const migrationPath = path.join(process.cwd(), 'prisma', 'migrations', '20240101000000_add_normalized_schema', 'migration.sql');
          let migrationSql = fs.readFileSync(migrationPath, 'utf8');

          await client.query('DROP TYPE IF EXISTS "UploadStatus" CASCADE');

          // Rename all new tables to avoid conflicts with legacy tables
          migrationSql = migrationSql.replace(/CREATE TABLE "vods"/g, 'CREATE TABLE "vods_new"');
          migrationSql = migrationSql.replace(/CREATE TABLE "emotes"/g, 'CREATE TABLE "emotes_new"');
          migrationSql = migrationSql.replace(/CREATE TABLE "games"/g, 'CREATE TABLE "games_new"');
          migrationSql = migrationSql.replace(/CREATE TABLE "chat_messages"/g, 'CREATE TABLE "chat_messages_new"');

          // Update all references to vods table in FK constraints
          migrationSql = migrationSql.replace(/REFERENCES "vods"\(/g, 'REFERENCES "vods_new"(');

          // Update constraint names
          migrationSql = migrationSql.replace(/CONSTRAINT "vods_pkey"/g, 'CONSTRAINT "vods_new_pkey"');
          migrationSql = migrationSql.replace(/CONSTRAINT "vods_platform_id_key"/g, 'CONSTRAINT "vods_new_platform_id_key"');
          migrationSql = migrationSql.replace(/CONSTRAINT "emotes_pkey"/g, 'CONSTRAINT "emotes_new_pkey"');
          migrationSql = migrationSql.replace(/CONSTRAINT "emotes_vod_id_key"/g, 'CONSTRAINT "emotes_new_vod_id_key"');
          migrationSql = migrationSql.replace(/CONSTRAINT "games_pkey"/g, 'CONSTRAINT "games_new_pkey"');
          migrationSql = migrationSql.replace(/CONSTRAINT "chat_messages_pkey"/g, 'CONSTRAINT "chat_messages_new_pkey"');

          // Update index ON clauses (table references in CREATE INDEX statements)
          migrationSql = migrationSql.replace(/ON "vods"\(/g, 'ON "vods_new"(');
          migrationSql = migrationSql.replace(/ON "emotes"\(/g, 'ON "emotes_new"(');
          migrationSql = migrationSql.replace(/ON "games"\(/g, 'ON "games_new"(');
          migrationSql = migrationSql.replace(/ON "chat_messages"\(/g, 'ON "chat_messages_new"(');

          // Update index names
          migrationSql = migrationSql.replace(/INDEX "vods_platform_idx"/g, 'INDEX "vods_new_platform_idx"');
          migrationSql = migrationSql.replace(/INDEX "emotes_vod_id_key"/g, 'INDEX "emotes_new_vod_id_key"');
          migrationSql = migrationSql.replace(/INDEX "games_vod_id_start_time_idx"/g, 'INDEX "games_new_vod_id_start_time_idx"');
          migrationSql = migrationSql.replace(/INDEX "games_game_name_idx"/g, 'INDEX "games_new_game_name_idx"');
          migrationSql = migrationSql.replace(/INDEX "chat_messages_vod_id_content_offset_seconds_id_idx"/g, 'INDEX "chat_messages_new_vod_id_content_offset_seconds_id_idx"');

          // Update foreign key constraint names
          migrationSql = migrationSql.replace(/CONSTRAINT "emotes_vod_id_fkey"/g, 'CONSTRAINT "emotes_new_vod_id_fkey"');
          migrationSql = migrationSql.replace(/CONSTRAINT "games_vod_id_fkey"/g, 'CONSTRAINT "games_new_vod_id_fkey"');

          // Update ALTER TABLE statements (only for tables that conflict with legacy)
          migrationSql = migrationSql.replace(/ALTER TABLE "emotes"/g, 'ALTER TABLE "emotes_new"');
          migrationSql = migrationSql.replace(/ALTER TABLE "games"/g, 'ALTER TABLE "games_new"');

          // Remove FK constraint lines for chat_messages and chapters (not needed as per schema design - no FK relations)
          migrationSql = migrationSql
            .split('\n')
            .filter((line) => {
              return !line.includes('ALTER TABLE "chat_messages"') && !line.includes('ALTER TABLE "chat_messages_new"') && !line.includes('chat_messages_vod_id_fkey');
            })
            .join('\n');

          await client.query(migrationSql);

          console.log('✅ New schema created successfully\n');

          const vods = await oldPool.query('SELECT * FROM vods');

          for (const vod of vods.rows) {
            const vodId = vod.id;
            const platform = vod.platform;
            const title = vod.title;
            const duration = parseDuration(vod.duration);
            const thumbnailUrl = vod.thumbnail_url;
            const streamId = vod.stream_id;

            await client.query(
              `
               INSERT INTO "vods_new" (id, platform, title, duration, thumbnail_url, stream_id)
               VALUES ($1, $2, $3, $4, $5, $6)
             `,
              [vodId, platform, title, duration, thumbnailUrl, streamId]
            );

            if (vod.youtube && Array.isArray(vod.youtube) && vod.youtube.length > 0) {
              for (const upload of vod.youtube) {
                const uploadId = `${vodId}-${upload.id}`;
                const duration = Math.round(Number(upload.duration) || 0);
                const part = Number(upload.part) || 0;
                await client.query(
                  `
                   INSERT INTO "vod_uploads" (vod_id, platform, upload_id, type, duration, part, status, thumbnail_url)
                   VALUES ($1, 'youtube', $2, $3, $4, $5, 'COMPLETED', $6)
                  `,
                  [vodId, uploadId, upload.type || null, duration, part, upload.thumbnail_url || null]
                );
              }
            }

            if (vod.chapters && Array.isArray(vod.chapters) && vod.chapters.length > 0) {
              for (const chapter of vod.chapters) {
                const start = Math.round(Number(chapter.start) || 0);
                const end = chapter.end ? Math.round(Number(chapter.end)) : null;
                await client.query(
                  `
                   INSERT INTO "chapters" (vod_id, game_id, name, image, duration, start, "end")
                   VALUES ($1, $2, $3, $4, $5, $6, $7)
                  `,
                  [vodId, chapter.gameId || null, chapter.name || null, chapter.image || null, chapter.duration || null, start, end]
                );
              }
            }
          }

          console.log(`✅ Migrated ${vods.rows.length} VODs`);

          const emotes = await oldPool.query('SELECT * FROM emotes');
          for (const emote of emotes.rows) {
            await client.query(
              `
               INSERT INTO "emotes_new" (vod_id, ffz_emotes, bttv_emotes, seventv_emotes)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (vod_id) DO UPDATE SET
                 ffz_emotes = EXCLUDED.ffz_emotes,
                 bttv_emotes = EXCLUDED.bttv_emotes,
                 seventv_emotes = EXCLUDED.seventv_emotes
             `,
              [emote.vod_id, JSON.stringify(emote.ffz_emotes), JSON.stringify(emote.bttv_emotes), JSON.stringify(emote['7tv_emotes'])]
            );
          }

          console.log(`✅ Migrated ${emotes.rows.length} emote records`);

          const games = await oldPool.query('SELECT * FROM games');
          for (const game of games.rows) {
            await client.query(
              `
               INSERT INTO "games_new" (vod_id, start_time, end_time, video_provider, video_id, thumbnail_url, game_id, game_name, title, chapter_image)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             `,
              [game.vod_id, game.start_time, game.end_time, game.video_provider, game.video_id, game.thumbnail_url, game.game_id, game.game_name, game.title, game.chapter_image]
            );
          }

          console.log(`✅ Migrated ${games.rows.length} games`);

          // Simply rename logs table to chat_messages (schema is identical)
          await client.query('ALTER TABLE logs RENAME TO chat_messages');
          console.log('✅ Renamed logs table to chat_messages\n');

          await client.query('COMMIT');
          console.log('✅ Transaction committed successfully\n');

          const newVodsCount = await oldPool.query('SELECT COUNT(*) FROM "vods_new"');
          const newUploadsCount = await oldPool.query('SELECT COUNT(*) FROM "vod_uploads"');
          const newEmotesCount = await oldPool.query('SELECT COUNT(*) FROM "emotes_new"');
          const newGamesCount = await oldPool.query('SELECT COUNT(*) FROM "games_new"');
          const newChaptersCount = await oldPool.query('SELECT COUNT(*) FROM "chapters"');
          const newChatMessagesCount = await oldPool.query('SELECT COUNT(*) FROM "chat_messages"');

          console.log('📊 New database row counts:');
          console.log(`   vods_new: ${newVodsCount.rows[0].count}`);
          console.log(`   vod_uploads: ${newUploadsCount.rows[0].count}`);
          console.log(`   emotes_new: ${newEmotesCount.rows[0].count}`);
          console.log(`   games_new: ${newGamesCount.rows[0].count}`);
          console.log(`   chapters: ${newChaptersCount.rows[0].count}`);
          console.log(`   chat_messages: ${newChatMessagesCount.rows[0].count}\n`);

          const renameLegacy = await confirm('Rename legacy tables and finalize migration?');
          if (renameLegacy) {
            await oldPool.query('ALTER TABLE "vods" RENAME TO "vods_legacy"');
            await oldPool.query('ALTER TABLE "vods_new" RENAME TO "vods"');
            await oldPool.query('ALTER TABLE "emotes" RENAME TO "emotes_legacy"');
            await oldPool.query('ALTER TABLE "emotes_new" RENAME TO "emotes"');
            await oldPool.query('ALTER TABLE "games" RENAME TO "games_legacy"');
            await oldPool.query('ALTER TABLE "games_new" RENAME TO "games"');
            await oldPool.query('ALTER TABLE "streams" RENAME TO "streams_legacy"');
            console.log('✅ Legacy tables renamed and migration finalized\n');

            const resolveMigrations = await confirm('Mark Prisma migrations as applied? This enables future prisma migrate deploy commands');
            if (resolveMigrations) {
              try {
                const { execSync } = await import('child_process');
                console.log('\n📝 Resolving migration state with Prisma...');

                execSync('npx prisma migrate resolve --applied 20240101000000_add_normalized_schema', {
                  stdio: 'inherit',
                  cwd: process.cwd(),
                });

                console.log('✅ Migration state resolved successfully\n');
              } catch (resolveError) {
                console.warn('⚠️  Failed to resolve migration state. You may need to run manually:');
                console.warn('   npx prisma migrate resolve --applied 20240101000000_add_normalized_schema\n');
              }

              try {
                const { execSync } = await import('child_process');
                console.log('📝 Applying remaining Prisma migrations...');

                execSync('npx prisma migrate deploy', {
                  stdio: 'inherit',
                  cwd: process.cwd(),
                });

                console.log('✅ All Prisma migrations applied successfully\n');
              } catch (deployError) {
                console.warn('⚠️  Failed to apply remaining migrations. You may need to run manually:');
                console.warn('   npx prisma migrate deploy\n');
              }
            } else {
              console.log('\nℹ️  To enable future Prisma migrations, run:');
              console.log('   npx prisma migrate resolve --applied 20240101000000_add_normalized_schema');
              console.log('   npx prisma migrate deploy\n');
            }
          } else {
            console.log('\nℹ️  To enable future Prisma migrations, run:');
            console.log('   npx prisma migrate resolve --applied 20240101000000_add_normalized_schema');
            console.log('   npx prisma migrate deploy\n');
          }

          console.log('🎉 Migration completed successfully!');
        } catch (error) {
          await client.query('ROLLBACK');
          console.error('❌ Migration failed, transaction rolled back:');
          console.error(error);
          process.exit(1);
        } finally {
          client.release();
        }
      } finally {
        await oldPool.end();
      }
    } catch (error) {
      console.error('❌ Migration failed:');
      console.error(error);
      process.exit(1);
    } finally {
      await metaClient.$disconnect();
    }
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
};

main();
