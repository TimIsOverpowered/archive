#!/usr/bin/env node
import 'dotenv/config';
import { PrismaClient } from '../prisma/generated/meta/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import readline from 'readline';
import { extractErrorDetails } from '../src/utils/error.js';

const { decryptScalar } = await import('../src/utils/encryption');

const META_DB_URL = process.env.META_DATABASE_URL;
if (!META_DB_URL) {
  console.error('❌ Missing META_DATABASE_URL environment variable');
  process.exit(1);
}

const adapter = new PrismaPg({ connectionString: META_DB_URL });
const metaClient = new PrismaClient({ adapter });

const createInterface = () => readline.createInterface({ input: process.stdin, output: process.stdout });

const prompt = (question: string): Promise<string> => {
  const rl = createInterface();
  return new Promise((resolve) => {
    rl.question(`${question} `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
};

const confirm = (question: string): Promise<boolean> => {
  const rl = createInterface();
  return new Promise((resolve) => {
    rl.question(`${question} [y/N]: `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
};

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

const createNormalizedSchema = async (client: any) => {
  await client.query('DROP TYPE IF EXISTS "UploadStatus" CASCADE');
  await client.query(`
    CREATE TYPE "UploadStatus" AS ENUM ('PENDING', 'UPLOADING', 'COMPLETED', 'FAILED');

    CREATE TABLE "vods_new" (
      "id" TEXT NOT NULL,
      "platform" TEXT NOT NULL,
      "title" TEXT,
      "duration" INTEGER DEFAULT 0 NOT NULL,
      "stream_id" TEXT,
      "created_at" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
      "is_live" BOOLEAN DEFAULT false NOT NULL,
      "started_at" TIMESTAMPTZ(3),
      CONSTRAINT "vods_new_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "vods_new_platform_id_key" UNIQUE ("platform", "id")
    );

    CREATE TABLE "vod_uploads" (
      "vod_id" TEXT NOT NULL,
      "upload_id" TEXT NOT NULL,
      "type" TEXT,
      "duration" INTEGER DEFAULT 0 NOT NULL,
      "part" INTEGER DEFAULT 0 NOT NULL,
      "status" "UploadStatus" DEFAULT 'PENDING' NOT NULL,
      "thumbnail_url" TEXT,
      "created_at" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
      CONSTRAINT "vod_uploads_pkey" PRIMARY KEY ("upload_id")
    );

    CREATE TABLE "emotes_new" (
      "id" SERIAL NOT NULL,
      "vod_id" TEXT NOT NULL,
      "ffz_emotes" JSONB,
      "bttv_emotes" JSONB,
      "seventv_emotes" JSONB,
      CONSTRAINT "emotes_new_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "emotes_new_vod_id_key" UNIQUE ("vod_id")
    );

    CREATE TABLE "games_new" (
      "id" SERIAL NOT NULL,
      "vod_id" TEXT NOT NULL,
      "start_time" INTEGER,
      "end_time" INTEGER,
      "video_provider" TEXT,
      "video_id" TEXT,
      "thumbnail_url" TEXT,
      "game_id" TEXT,
      "game_name" TEXT,
      "title" TEXT,
      "chapter_image" TEXT,
      CONSTRAINT "games_new_pkey" PRIMARY KEY ("id")
    );

    CREATE TABLE "chapters" (
      "id" SERIAL NOT NULL,
      "vod_id" TEXT NOT NULL,
      "game_id" TEXT,
      "name" TEXT,
      "image" TEXT,
      "duration" TEXT,
      "start" INTEGER DEFAULT 0 NOT NULL,
      "end" INTEGER,
      CONSTRAINT "chapters_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "chapters_vod_id_start_key" UNIQUE ("vod_id", "start")
    );

    CREATE INDEX "vods_new_platform_idx" ON "vods_new"("platform");
    CREATE INDEX "vod_uploads_vod_id_idx" ON "vod_uploads"("vod_id");
    CREATE INDEX "vod_uploads_status_idx" ON "vod_uploads"("status");
    CREATE INDEX "vod_uploads_type_idx" ON "vod_uploads"("type");
    CREATE INDEX "vod_uploads_vod_id_type_part_idx" ON "vod_uploads"("vod_id", "type", "part");
    CREATE INDEX "games_new_game_name_idx" ON "games_new"("game_name");
    CREATE INDEX "games_new_vod_id_start_time_idx" ON "games_new"("vod_id", "start_time");
    CREATE INDEX "chapters_vod_id_start_idx" ON "chapters"("vod_id", "start");

    ALTER TABLE "vod_uploads" ADD CONSTRAINT "vod_uploads_vod_id_fkey" FOREIGN KEY ("vod_id") REFERENCES "vods_new"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE "emotes_new" ADD CONSTRAINT "emotes_new_vod_id_fkey" FOREIGN KEY ("vod_id") REFERENCES "vods_new"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE "games_new" ADD CONSTRAINT "games_new_vod_id_fkey" FOREIGN KEY ("vod_id") REFERENCES "vods_new"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE "chapters" ADD CONSTRAINT "chapters_vod_id_fkey" FOREIGN KEY ("vod_id") REFERENCES "vods_new"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  `);
};

const applySchemaMigrations = async (client: any) => {
  await client.query(`
    ALTER TABLE "vods_new" 
    ADD COLUMN IF NOT EXISTS "is_live" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "started_at" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "ended_at" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "user_id" TEXT;

    CREATE INDEX IF NOT EXISTS "vods_is_live_idx" ON "vods_new"("is_live");
    CREATE INDEX IF NOT EXISTS "vods_user_id_platform_idx" ON "vods_new"("user_id", "platform");

    COMMENT ON COLUMN "vods_new"."is_live" IS 'Indicates if this VOD record represents an active live stream';
    COMMENT ON COLUMN "vods_new"."started_at" IS 'Timestamp when the live stream started (set on offline->live transition)';
    COMMENT ON COLUMN "vods_new"."ended_at" IS 'Timestamp when the live stream ended (set on live->offline transition)';
    COMMENT ON COLUMN "vods_new"."user_id" IS 'Channel/user identifier for tracking which channel this VOD belongs to (multi-tenant/multi-channel support)';
  `);

  await client.query(`
    UPDATE "vod_uploads" vu
    SET thumbnail_url = v.thumbnail_url
    FROM "vods_new" v
    WHERE vu.vod_id = v.id 
      AND v.thumbnail_url IS NOT NULL 
      AND vu.thumbnail_url IS NULL;

    ALTER TABLE "vods_new" DROP COLUMN IF EXISTS "downloaded_at";
    ALTER TABLE "vods_new" DROP COLUMN IF EXISTS "thumbnail_url";
    ALTER TABLE "vods_new" DROP COLUMN IF EXISTS "user_id";
    DROP INDEX IF EXISTS "vods_user_id_platform_idx";
    ALTER TABLE "vods_new" DROP COLUMN IF EXISTS "ended_at";

    ALTER TABLE "vods_new" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
    UPDATE "vods_new" SET "updated_at" = COALESCE("created_at", NOW()) WHERE "updated_at" IS NULL;

    CREATE OR REPLACE FUNCTION update_updated_at_column()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = CURRENT_TIMESTAMP;
      RETURN NEW;
    END;
    $$ language 'plpgsql';

    DROP TRIGGER IF EXISTS update_vods_updated_at ON "vods_new";
    CREATE TRIGGER update_vods_updated_at 
    BEFORE UPDATE ON "vods_new" 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

    CREATE INDEX IF NOT EXISTS "vods_updated_at_idx" ON "vods_new"("updated_at");
  `);

  await client.query(`
    ALTER TABLE "chat_messages" 
    ADD CONSTRAINT "chat_messages_vod_id_fkey" 
    FOREIGN KEY ("vod_id") REFERENCES "vods_new"("id") ON DELETE CASCADE;
  `);

  await client.query(`
    UPDATE "chat_messages" SET "created_at" = NOW() WHERE "created_at" IS NULL;
    ALTER TABLE "chat_messages" ALTER COLUMN "created_at" SET NOT NULL;
    DROP INDEX IF EXISTS "idx_chat_messages_vod_offset_id";
    CREATE INDEX "idx_chat_messages_vod_offset_created" ON "chat_messages"("vod_id", "content_offset_seconds", "created_at");
  `);
};

const main = async () => {
  console.log('\n🚀 Starting migration\n');

  const streamerName = await prompt('Streamer name (tenant identifier)');
  if (!streamerName) {
    console.error('❌ Streamer name is required');
    process.exit(1);
  }

  // Fetch database URL from meta database for this tenant and decrypt it
  let dbUrl: string | null;
  try {
    const tenant = await metaClient.tenant.findUnique({
      where: { id: streamerName },
      select: { databaseUrl: true },
    });

    if (!tenant?.databaseUrl) {
      console.error(`❌ Tenant "${streamerName}" not found in meta database`);
      process.exit(1);
    }

    try {
      dbUrl = decryptScalar(tenant.databaseUrl as string);
    } catch (decryptError) {
      const details = extractErrorDetails(decryptError);
      console.error('❌ Failed to decrypt database URL:', details.message);
      await metaClient.$disconnect();
      process.exit(1);
    }
  } catch (error) {
    const details = extractErrorDetails(error);
    console.error('❌ Failed to fetch tenant from meta database:', details.message);
    await metaClient.$disconnect();
    process.exit(1);
  }

  let dryRunMode = false;
  const modeAnswer = await prompt('Dry run only? (y/N to skip validation-only mode)');
  if (modeAnswer.toLowerCase() === 'y' || modeAnswer.toLowerCase() === 'yes') {
    dryRunMode = true;
  }

  console.log(`\n📋 Migration details:`);
  console.log(`   Streamer: ${streamerName}`);
  console.log(`   Database URL: ${dbUrl.replace(/\/\/.*@/, '//***:***@')}`);
  console.log(`   Dry run mode: ${dryRunMode ? 'YES' : 'NO'}\n`);

  const errors: string[] = [];
  let poolEnded = false;

  try {
    const pg = await import('pg');
    const oldPool = new pg.Pool({ connectionString: dbUrl });

    let isAlreadyMigrated = false;
    try {
      const vodsResult = await oldPool.query("SELECT COUNT(*) FROM vods WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'vods' AND column_name = 'youtube')");
      isAlreadyMigrated = Number(vodsResult.rows[0].count) > 0;

      if (isAlreadyMigrated) {
        console.log('⚠️  Migration appears to already be completed or partially done');
        console.log('   Check tables: vods, emotes, games, chapters\n');
        poolEnded = true;
        await oldPool.end();
        return;
      }

      const oldVodsCount = await oldPool.query('SELECT COUNT(*) FROM vods');
      const oldEmotesCount = await oldPool.query('SELECT COUNT(*) FROM emotes');
      const oldGamesCount = await oldPool.query('SELECT COUNT(*) FROM games');

      console.log('📊 Legacy database row counts:');
      console.log(`   vods: ${oldVodsCount.rows[0].count}`);
      console.log(`   emotes: ${oldEmotesCount.rows[0].count}`);
      console.log(`   games: ${oldGamesCount.rows[0].count}\n`);

      if (dryRunMode) {
        console.log('✅ Dry run validation complete');
        console.log(`   Would migrate: ${oldVodsCount.rows[0].count} VODs`);
        console.log(`   Would migrate: ${oldEmotesCount.rows[0].count} emote records`);
        console.log(`   Would migrate: ${oldGamesCount.rows[0].count} game records\n`);
        poolEnded = true;
        await oldPool.end();
        return;
      }

      const proceed = await confirm('Proceed with migration? This will create new tables and migrate data');
      if (!proceed) {
        console.log('\n❌ Migration cancelled by user\n');
        process.exit(0);
      }

      const client = await oldPool.connect();
      try {
        await client.query('BEGIN');

        try {
          await createNormalizedSchema(client);
          console.log('✅ New schema created successfully\n');
        } catch (schemaError) {
          errors.push(`Failed to create new schema: ${String(schemaError)}`);
          throw schemaError;
        }

        try {
          const vods = await oldPool.query('SELECT * FROM vods');

          for (const vod of vods.rows) {
            const vodId = vod.id;
            const platform = vod.platform;
            const title = vod.title;
            const duration = parseDuration(vod.duration);
            const thumbnailUrl = vod.thumbnail_url;
            const streamId = vod.stream_id;

            try {
              await client.query(`INSERT INTO "vods_new" (id, platform, title, duration, stream_id) VALUES ($1, $2, $3, $4, $5)`, [vodId, platform, title, duration, streamId]);

              if (vod.youtube && Array.isArray(vod.youtube) && vod.youtube.length > 0) {
                for (const upload of vod.youtube) {
                  const uploadId = `${vodId}-${upload.id}`;
                  const uploadDuration = Math.round(Number(upload.duration) || 0);
                  const part = Number(upload.part) || 0;

                  try {
                    await client.query(`INSERT INTO "vod_uploads" (vod_id, upload_id, type, duration, part, status, thumbnail_url) VALUES ($1, $2, $3, $4, $5, 'COMPLETED', $6)`, [
                      vodId,
                      uploadId,
                      upload.type || null,
                      uploadDuration,
                      part,
                      upload.thumbnail_url || thumbnailUrl || null,
                    ]);
                  } catch (uploadError) {
                    errors.push(`Failed to migrate YouTube upload ${uploadId}: ${String(uploadError)}`);
                  }
                }
              }

              if (vod.chapters && Array.isArray(vod.chapters) && vod.chapters.length > 0) {
                for (const chapter of vod.chapters) {
                  const start = Math.round(Number(chapter.start) || 0);
                  const end = chapter.end ? Math.round(Number(chapter.end)) : null;

                  try {
                    await client.query(`INSERT INTO "chapters" (vod_id, game_id, name, image, duration, start, "end") VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
                      vodId,
                      chapter.gameId || null,
                      chapter.name || null,
                      chapter.image || null,
                      chapter.duration || null,
                      start,
                      end,
                    ]);
                  } catch (chapterError) {
                    errors.push(`Failed to migrate chapter for VOD ${vodId}: ${String(chapterError)}`);
                  }
                }
              }
            } catch (vodError) {
              errors.push(`Failed to migrate VOD ${vodId}: ${String(vodError)}`);
            }
          }

          console.log(`✅ Migrated ${vods.rows.length} VODs`);
        } catch (vodsError) {
          errors.push(`VOD migration failed: ${String(vodsError)}`);
          throw vodsError;
        }

        try {
          const emotes = await oldPool.query('SELECT * FROM emotes');
          for (const emote of emotes.rows) {
            try {
              await client.query(
                `INSERT INTO "emotes_new" (vod_id, ffz_emotes, bttv_emotes, seventv_emotes) VALUES ($1, $2, $3, $4) ON CONFLICT (vod_id) DO UPDATE SET ffz_emotes = EXCLUDED.ffz_emotes, bttv_emotes = EXCLUDED.bttv_emotes, seventv_emotes = EXCLUDED.seventv_emotes`,
                [emote.vod_id, JSON.stringify(emote.ffz_emotes), JSON.stringify(emote.bttv_emotes), JSON.stringify(emote['7tv_emotes'])]
              );
            } catch (emoteError) {
              errors.push(`Failed to migrate emote for VOD ${emote.vod_id}: ${String(emoteError)}`);
            }
          }

          console.log(`✅ Migrated ${emotes.rows.length} emote records`);
        } catch (emotesError) {
          errors.push(`Emote migration failed: ${String(emotesError)}`);
          throw emotesError;
        }

        try {
          const games = await oldPool.query('SELECT * FROM games');
          for (const game of games.rows) {
            try {
              const startTime = game.start_time ? Math.round(Number(game.start_time)) : null;
              const endTime = game.end_time ? Math.round(Number(game.end_time)) : null;

              await client.query(
                `INSERT INTO "games_new" (vod_id, start_time, end_time, video_provider, video_id, thumbnail_url, game_id, game_name, title, chapter_image) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [game.vod_id, startTime, endTime, game.video_provider, game.video_id, game.thumbnail_url, game.game_id, game.game_name, game.title, game.chapter_image]
              );
            } catch (gameError) {
              errors.push(`Failed to migrate game for VOD ${game.vod_id}: ${String(gameError)}`);
            }
          }

          console.log(`✅ Migrated ${games.rows.length} games`);
        } catch (gamesError) {
          errors.push(`Game migration failed: ${String(gamesError)}`);
          throw gamesError;
        }

        try {
          await client.query('ALTER TABLE logs RENAME TO chat_messages');
          await client.query('ALTER TABLE "chat_messages" RENAME COLUMN "createdAt" TO "created_at"');
          await client.query('ALTER TABLE "chat_messages" DROP COLUMN "updatedAt"');
          console.log('✅ Renamed logs table to chat_messages');
        } catch (renameError) {
          errors.push(`Failed to rename logs table: ${String(renameError)}`);
          throw renameError;
        }

        try {
          await applySchemaMigrations(client);
          console.log('✅ Schema migrations applied');
        } catch (schemaMigrationError) {
          errors.push(`Failed to apply schema migrations: ${String(schemaMigrationError)}`);
          throw schemaMigrationError;
        }

        await client.query('COMMIT');
        console.log('✅ Transaction committed successfully\n');

        const newVodsCount = await oldPool.query('SELECT COUNT(*) FROM "vods_new"');
        const newUploadsCount = await oldPool.query('SELECT COUNT(*) FROM "vod_uploads"');
        const newEmotesCount = await oldPool.query('SELECT COUNT(*) FROM "emotes_new"');
        const newGamesCount = await oldPool.query('SELECT COUNT(*) FROM "games_new"');
        const newChaptersCount = await oldPool.query('SELECT COUNT(*) FROM "chapters"');

        console.log('📊 New database row counts:');
        console.log(`   vods_new: ${newVodsCount.rows[0].count}`);
        console.log(`   vod_uploads: ${newUploadsCount.rows[0].count}`);
        console.log(`   emotes_new: ${newEmotesCount.rows[0].count}`);
        console.log(`   games_new: ${newGamesCount.rows[0].count}`);
        console.log(`   chapters: ${newChaptersCount.rows[0].count}\n`);

        const renameLegacy = await confirm('Rename legacy tables and finalize migration?');
        if (renameLegacy) {
          try {
            await oldPool.query('ALTER TABLE "vods" RENAME TO "vods_legacy"');
            await oldPool.query('ALTER TABLE "vods_new" RENAME TO "vods"');
            await oldPool.query('ALTER TABLE "emotes" RENAME TO "emotes_legacy"');
            await oldPool.query('ALTER TABLE "emotes_new" RENAME TO "emotes"');
            await oldPool.query('ALTER TABLE "games" RENAME TO "games_legacy"');
            await oldPool.query('ALTER TABLE "games_new" RENAME TO "games"');

            try {
              await oldPool.query('ALTER TABLE "streams" RENAME TO "streams_legacy"');
            } catch (streamsError) {
              errors.push(`Failed to rename streams table (may not exist): ${String(streamsError)}`);
            }

            console.log('✅ Legacy tables renamed and migration finalized\n');
          } catch (renameError) {
            errors.push(`Failed to rename legacy tables: ${String(renameError)}`);
            throw renameError;
          }
        } else {
          console.log('\nℹ️  Migration data is in *_new tables. To finalize, run manually or re-run this script.');
          console.log('   Run: ALTER TABLE "vods_new" RENAME TO "vods"; etc.\n');
        }

        if (errors.length > 0) {
          console.log('\n⚠️  Migration completed with warnings:\n');
          errors.forEach((err, i) => console.log(`   ${i + 1}. ${err}`));
          console.log('');
        } else {
          console.log('🎉 Migration completed successfully!\n');
        }
      } catch (transactionError) {
        try {
          await client.query('ROLLBACK');
          errors.push(`Transaction rolled back due to error: ${String(transactionError)}`);
          console.error('\n❌ Migration failed, transaction rolled back:');
          console.error(transactionError);
        } catch (rollbackError) {
          errors.push(`Failed to rollback transaction: ${String(rollbackError)}`);
          console.error('⚠️  Failed to rollback transaction:', rollbackError);
        }

        if (errors.length > 0) {
          console.log('\n❌ Errors encountered:\n');
          errors.forEach((err, i) => console.log(`   ${i + 1}. ${err}`));
          console.log('');
        }

        process.exit(1);
      } finally {
        client.release();
      }
    } catch (migrationError) {
      errors.push(`Migration failed: ${String(migrationError)}`);
      console.error('\n❌ Migration failed:');
      console.error(migrationError);

      if (errors.length > 0) {
        console.log('\n❌ Errors encountered:\n');
        errors.forEach((err, i) => console.log(`   ${i + 1}. ${err}`));
        console.log('');
      }

      process.exit(1);
    } finally {
      if (!poolEnded) {
        await oldPool.end();
      }
      await metaClient.$disconnect();
    }
  } catch (initError) {
    errors.push(`Initialization error: ${String(initError)}`);
    console.error('\n❌ Error:', initError);

    if (errors.length > 0) {
      console.log('\n❌ Errors encountered:\n');
      errors.forEach((err, i) => console.log(`   ${i + 1}. ${err}`));
      console.log('');
    }

    process.exit(1);
  }
};

main();
