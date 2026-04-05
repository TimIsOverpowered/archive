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

interface ChatWorkerProgress {
  workerId: number;
  processed: number;
  target: number;
  startTime: number;
  completed: boolean;
}

function getUuidRanges(workerCount: number): Array<{ min: string; max: string }> {
  const ranges: Array<{ min: string; max: string }> = [];
  const maxUuid = 0xffffffffffffffffffffffffffffffffn;
  const step = maxUuid / BigInt(workerCount);

  for (let i = 0; i < workerCount; i++) {
    const min = (step * BigInt(i)).toString(16).padStart(32, '0');
    const max = i === workerCount - 1 ? maxUuid.toString(16) : (step * BigInt(i + 1) - 1n).toString(16).padStart(32, '0');
    ranges.push({ min, max });
  }

  return ranges;
}

async function migrateChatWorker(
  oldPool: any,
  newPool: any,
  range: { min: string; max: string },
  workerId: number,
  batchSize: number,
  vodIdMap: Map<string, number>,
  progressCallback: (progress: ChatWorkerProgress) => void
): Promise<{ processed: number }> {
  const oldConn = await oldPool.connect();
  const newConn = await newPool.connect();
  let processed = 0;
  const startTime = Date.now();
  let completed = false;

  try {
    await oldConn.query('BEGIN');
    await newConn.query('BEGIN');

    await oldConn.query(
      `DECLARE chat_cursor CURSOR FOR 
       SELECT cm.id, cm.vod_id, cm.display_name, cm.content_offset_seconds,
              cm.user_color, cm."createdAt", cm.message, cm.user_badges
       FROM logs cm
       WHERE cm.id >= $1::uuid AND cm.id <= $2::uuid
       ORDER BY cm.id`,
      [range.min, range.max]
    );

    try {
      while (true) {
        const rows: any = await oldConn.query(`FETCH FORWARD ${batchSize} IN chat_cursor`);

        if (rows.rows.length === 0) break;

        const insertRows: any[] = [];
        for (const row of rows.rows) {
          const newVodId = vodIdMap.get(row.vod_id);
          if (newVodId) {
            insertRows.push([row.id, newVodId, row.display_name, row.content_offset_seconds, row.user_color, row.createdAt, row.message, row.user_badges]);
          }
        }

        if (insertRows.length > 0) {
          const placeholders = insertRows.map((_, i) => `($${i * 8 + 1}, $${i * 8 + 2}, $${i * 8 + 3}, $${i * 8 + 4}, $${i * 8 + 5}, $${i * 8 + 6}, $${i * 8 + 7}, $${i * 8 + 8})`).join(', ');

          await newConn.query(
            `INSERT INTO "chat_messages_new" 
             (id, vod_id, display_name, content_offset_seconds, user_color, created_at, message, user_badges)
             VALUES ${placeholders}`,
            insertRows.flat()
          );
        }

        processed += insertRows.length;
        progressCallback({ workerId, processed, target: 0, startTime, completed });
      }

      completed = true;
      progressCallback({ workerId, processed, target: 0, startTime, completed });
    } finally {
      await oldConn.query('CLOSE chat_cursor');
    }

    await oldConn.query('COMMIT');
    await newConn.query('COMMIT');
  } catch (error) {
    try {
      await oldConn.query('ROLLBACK');
      await newConn.query('ROLLBACK');
    } catch (rollbackError) {}
    throw error;
  } finally {
    oldConn.release();
    newConn.release();
  }

  return { processed };
}

async function migrateChatMessagesParallel(
  oldPool: any,
  newPool: any,
  totalChat: number,
  workerCount: number,
  batchSize: number,
  vodIdMap: Map<string, number>,
  streamerName: string
): Promise<{ processed: number }> {
  const ranges = getUuidRanges(workerCount);
  const globalStartTime = Date.now();

  const workerProgress: ChatWorkerProgress[] = ranges.map((_, i) => ({
    workerId: i + 1,
    processed: 0,
    target: Math.ceil(totalChat / workerCount),
    startTime: globalStartTime,
    completed: false,
  }));

  const updateProgress = (progress: ChatWorkerProgress) => {
    const idx = workerProgress.findIndex((wp) => wp.workerId === progress.workerId);
    if (idx !== -1) {
      workerProgress[idx] = progress;
    }
  };

  const displayProgress = () => {
    const now = Date.now();
    const elapsedSec = Math.floor((now - globalStartTime) / 1000);
    const elapsedMins = Math.floor(elapsedSec / 60);
    const elapsedSecs = elapsedSec % 60;
    const elapsedStr = `${elapsedMins.toString().padStart(2, '0')}:${elapsedSecs.toString().padStart(2, '0')}`;

    const totalProcessed = workerProgress.reduce((sum, wp) => sum + wp.processed, 0);
    const overallPercent = totalChat > 0 ? (totalProcessed / totalChat) * 100 : 0;

    let overallRate = 0;
    if (elapsedSec > 0) {
      overallRate = totalProcessed / elapsedSec;
    }

    let etaStr = '--:--';
    if (overallRate > 0 && totalProcessed < totalChat) {
      const remaining = totalChat - totalProcessed;
      const remainingSec = Math.ceil(remaining / overallRate);
      const remainingMins = Math.floor(remainingSec / 60);
      const remainingSecs = remainingSec % 60;
      etaStr = `${remainingMins.toString().padStart(2, '0')}:${remainingSecs.toString().padStart(2, '0')}`;
    }

    console.log('\x1B[2J\x1B[H');
    console.log(`🔄 Migrating chat messages for "${streamerName}"\n`);
    console.log(`   Started: ${new Date(globalStartTime).toLocaleTimeString()}`);
    console.log(`   Elapsed: ${elapsedStr} | ETA: ${etaStr}\n`);

    workerProgress.forEach((wp) => {
      const workerElapsed = Math.floor((now - wp.startTime) / 1000);
      const workerRate = workerElapsed > 0 ? wp.processed / workerElapsed : 0;
      const status = wp.completed ? '✓' : '';
      const rateStr = workerRate > 0 ? ` (${workerRate.toFixed(1)}/s)` : '';
      console.log(`   Worker ${wp.workerId}: ${wp.processed.toLocaleString()} processed ${status}${rateStr}`);
    });

    console.log('   ─────────────────────────────────────────────');
    console.log(`   Total: ${totalProcessed.toLocaleString()}/${totalChat.toLocaleString()} (${overallPercent.toFixed(1)}%) | Rate: ${overallRate.toFixed(1)}/s\n`);
  };

  const progressInterval = setInterval(displayProgress, 1000);

  try {
    const results = await Promise.all(ranges.map((range, i) => migrateChatWorker(oldPool, newPool, range, i + 1, batchSize, vodIdMap, updateProgress)));

    clearInterval(progressInterval);
    displayProgress();

    const totalProcessed = results.reduce((sum, r) => sum + r.processed, 0);
    return { processed: totalProcessed };
  } catch (error) {
    clearInterval(progressInterval);
    throw error;
  }
}

const rollbackMigration = async (client: any) => {
  console.log('🔄 Rolling back migration...');

  try {
    await client.query('DROP TABLE IF EXISTS "vods_new" CASCADE');
    await client.query('DROP TABLE IF EXISTS "vod_uploads" CASCADE');
    await client.query('DROP TABLE IF EXISTS "emotes_new" CASCADE');
    await client.query('DROP TABLE IF EXISTS "games_new" CASCADE');
    await client.query('DROP TABLE IF EXISTS "chapters" CASCADE');
    await client.query('DROP TABLE IF EXISTS "chat_messages_new" CASCADE');

    console.log('✅ Rollback complete');
  } catch (error) {
    console.error('❌ Rollback failed:', error);
    throw error;
  }
};

const createNormalizedSchema = async (client: any) => {
  await client.query('DROP TYPE IF EXISTS "UploadStatus" CASCADE');
  await client.query(`
    CREATE TYPE "UploadStatus" AS ENUM ('PENDING', 'UPLOADING', 'COMPLETED', 'FAILED');

    CREATE TABLE "vods_new" (
      "id" SERIAL NOT NULL,
      "vod_id" TEXT NOT NULL,
      "platform" TEXT NOT NULL,
      "title" TEXT,
      "duration" INTEGER DEFAULT 0 NOT NULL,
      "stream_id" TEXT,
      "created_at" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
      "is_live" BOOLEAN DEFAULT false NOT NULL,
      "started_at" TIMESTAMPTZ(3),
      "updated_at" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
      CONSTRAINT "vods_new_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "vods_new_platform_vod_id_key" UNIQUE ("platform", "vod_id")
    );

    CREATE TABLE "vod_uploads" (
      "vod_id" INTEGER NOT NULL,
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
      "vod_id" INTEGER NOT NULL,
      "ffz_emotes" JSONB,
      "bttv_emotes" JSONB,
      "seventv_emotes" JSONB,
      CONSTRAINT "emotes_new_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "emotes_new_vod_id_key" UNIQUE ("vod_id")
    );

    CREATE TABLE "games_new" (
      "id" SERIAL NOT NULL,
      "vod_id" INTEGER NOT NULL,
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
      "vod_id" INTEGER NOT NULL,
      "game_id" TEXT,
      "name" TEXT,
      "image" TEXT,
      "duration" TEXT,
      "start" INTEGER DEFAULT 0 NOT NULL,
      "end" INTEGER,
      CONSTRAINT "chapters_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "chapters_vod_id_start_key" UNIQUE ("vod_id", "start")
    );

    CREATE TABLE "chat_messages_new" (
      "id" UUID NOT NULL,
      "vod_id" INTEGER NOT NULL,
      "display_name" TEXT,
      "content_offset_seconds" DECIMAL NOT NULL,
      "user_color" TEXT,
      "created_at" TIMESTAMPTZ(6) NOT NULL,
      "message" JSONB,
      "user_badges" JSONB,
      CONSTRAINT "chat_messages_new_pkey" PRIMARY KEY ("id")
    );

    CREATE INDEX "vods_new_platform_idx" ON "vods_new"("platform");
    CREATE INDEX "vod_uploads_vod_id_idx" ON "vod_uploads"("vod_id");
    CREATE INDEX "vod_uploads_status_idx" ON "vod_uploads"("status");
    CREATE INDEX "vod_uploads_type_idx" ON "vod_uploads"("type");
    CREATE INDEX "vod_uploads_vod_id_type_part_idx" ON "vod_uploads"("vod_id", "type", "part");
    CREATE INDEX "games_new_game_name_idx" ON "games_new"("game_name");
    CREATE INDEX "games_new_vod_id_start_time_idx" ON "games_new"("vod_id", "start_time");
    CREATE INDEX "chapters_vod_id_start_idx" ON "chapters"("vod_id", "start");
    CREATE INDEX "idx_chat_messages_new_vod_offset_created" ON "chat_messages_new"("vod_id", "content_offset_seconds", "created_at");

    ALTER TABLE "vod_uploads" ADD CONSTRAINT "vod_uploads_vod_id_fkey" FOREIGN KEY ("vod_id") REFERENCES "vods_new"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE "emotes_new" ADD CONSTRAINT "emotes_new_vod_id_fkey" FOREIGN KEY ("vod_id") REFERENCES "vods_new"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE "games_new" ADD CONSTRAINT "games_new_vod_id_fkey" FOREIGN KEY ("vod_id") REFERENCES "vods_new"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE "chapters" ADD CONSTRAINT "chapters_vod_id_fkey" FOREIGN KEY ("vod_id") REFERENCES "vods_new"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE "chat_messages_new" ADD CONSTRAINT "chat_messages_new_vod_id_fkey" FOREIGN KEY ("vod_id") REFERENCES "vods_new"("id") ON DELETE CASCADE;
  `);
};

const applySchemaMigrations = async (client: any) => {
  await client.query(`
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
};

const main = async () => {
  console.log('\n🚀 Starting migration\n');

  const streamerName = await prompt('Streamer name (tenant identifier)');
  if (!streamerName) {
    console.error('❌ Streamer name is required');
    process.exit(1);
  }

  let chatWorkers = 4;
  let chatBatchSize = 100000;
  const workersAnswer = await prompt('Number of chat migration workers? [4]:');
  if (workersAnswer && workersAnswer.trim()) {
    const parsed = parseInt(workersAnswer, 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= 8) {
      chatWorkers = parsed;
    }
  }
  const batchSizeAnswer = await prompt('Chat migration batch size? [100000]:');
  if (batchSizeAnswer && batchSizeAnswer.trim()) {
    const parsed = parseInt(batchSizeAnswer, 10);
    if (!isNaN(parsed) && parsed >= 10000 && parsed <= 500000) {
      chatBatchSize = parsed;
    }
  }

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
      const oldLogsCount = await oldPool.query('SELECT COUNT(*) FROM logs');

      console.log('📊 Legacy database row counts:');
      console.log(`   vods: ${oldVodsCount.rows[0].count}`);
      console.log(`   emotes: ${oldEmotesCount.rows[0].count}`);
      console.log(`   games: ${oldGamesCount.rows[0].count}`);
      console.log(`   logs (chat messages): ${oldLogsCount.rows[0].count}\n`);

      if (dryRunMode) {
        console.log('✅ Dry run validation complete');
        console.log(`   Would migrate: ${oldVodsCount.rows[0].count} VODs`);
        console.log(`   Would migrate: ${oldEmotesCount.rows[0].count} emote records`);
        console.log(`   Would migrate: ${oldGamesCount.rows[0].count} game records`);
        console.log(`   Would migrate: ${oldLogsCount.rows[0].count} chat messages\n`);
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

        const streamsResult = await oldPool.query('SELECT id, started_at FROM streams WHERE started_at IS NOT NULL');
        const streamsMap = new Map<string, Date>();
        for (const stream of streamsResult.rows) {
          if (stream.id && stream.started_at) {
            streamsMap.set(String(stream.id), new Date(stream.started_at));
          }
        }

        const vods = await oldPool.query('SELECT * FROM vods ORDER BY "createdAt" ASC');

        const vodIdMap = new Map<string, number>();

        for (let i = 0; i < vods.rows.length; i++) {
          const vod = vods.rows[i];
          const legacyVodId = vod.id;
          const newId = i + 1;

          const platform = vod.platform;
          const title = vod.title;
          const duration = parseDuration(vod.duration);
          const thumbnailUrl = vod.thumbnail_url;
          const streamId = vod.stream_id;
          const vodStartedAt = streamId ? streamsMap.get(streamId) || null : null;

          try {
            await client.query(
              `INSERT INTO "vods_new" (id, vod_id, platform, title, duration, stream_id, started_at, created_at) 
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [newId, legacyVodId, platform, title, duration, streamId, vodStartedAt, vod.createdAt || new Date()]
            );

            vodIdMap.set(legacyVodId, newId);

            if (vod.youtube && Array.isArray(vod.youtube) && vod.youtube.length > 0) {
              for (const upload of vod.youtube) {
                const uploadId = `${legacyVodId}-${upload.id}`;
                const uploadDuration = Math.round(Number(upload.duration) || 0);
                const part = Number(upload.part) || 0;

                try {
                  await client.query(
                    `INSERT INTO "vod_uploads" (vod_id, upload_id, type, duration, part, status, thumbnail_url) 
                     VALUES ($1, $2, $3, $4, $5, 'COMPLETED', $6)`,
                    [newId, uploadId, upload.type || null, uploadDuration, part, upload.thumbnail_url || thumbnailUrl || null]
                  );
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
                  await client.query(
                    `INSERT INTO "chapters" (vod_id, game_id, name, image, duration, start, "end") 
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [newId, chapter.gameId || null, chapter.name || null, chapter.image || null, chapter.duration || null, start, end]
                  );
                } catch (chapterError) {
                  errors.push(`Failed to migrate chapter for VOD ${legacyVodId}: ${String(chapterError)}`);
                }
              }
            }
          } catch (vodError) {
            errors.push(`Failed to migrate VOD ${legacyVodId}: ${String(vodError)}`);
          }
        }

        console.log(`✅ Migrated ${vods.rows.length} VODs`);

        const emotes = await oldPool.query('SELECT * FROM emotes');
        for (const emote of emotes.rows) {
          const newVodId = vodIdMap.get(emote.vod_id);
          if (!newVodId) {
            throw new Error(`Emote references non-existent VOD ${emote.vod_id} - FK integrity failed`);
          }

          try {
            await client.query(
              `INSERT INTO "emotes_new" (vod_id, ffz_emotes, bttv_emotes, seventv_emotes) 
               VALUES ($1, $2, $3, $4) ON CONFLICT (vod_id) DO UPDATE 
               SET ffz_emotes = EXCLUDED.ffz_emotes, 
                   bttv_emotes = EXCLUDED.bttv_emotes, 
                   seventv_emotes = EXCLUDED.seventv_emotes`,
              [newVodId, JSON.stringify(emote.ffz_emotes), JSON.stringify(emote.bttv_emotes), JSON.stringify(emote['7tv_emotes'])]
            );
          } catch (emoteError) {
            errors.push(`Failed to migrate emote for VOD ${emote.vod_id}: ${String(emoteError)}`);
          }
        }

        console.log(`✅ Migrated ${emotes.rows.length} emote records`);

        const games = await oldPool.query('SELECT * FROM games');
        for (const game of games.rows) {
          const newVodId = vodIdMap.get(game.vod_id);
          if (!newVodId) {
            throw new Error(`Game references non-existent VOD ${game.vod_id} - FK integrity failed`);
          }

          const startTime = game.start_time ? Math.round(Number(game.start_time)) : null;
          const endTime = game.end_time ? Math.round(Number(game.end_time)) : null;

          try {
            await client.query(
              `INSERT INTO "games_new" (vod_id, start_time, end_time, video_provider, video_id, thumbnail_url, game_id, game_name, title, chapter_image) 
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
              [newVodId, startTime, endTime, game.video_provider, game.video_id, game.thumbnail_url, game.game_id, game.game_name, game.title, game.chapter_image]
            );
          } catch (gameError) {
            errors.push(`Failed to migrate game for VOD ${game.vod_id}: ${String(gameError)}`);
          }
        }

        console.log(`✅ Migrated ${games.rows.length} games`);

        const orphanedChatCheck = await client.query(`
  SELECT COUNT(*) FROM logs cm
  WHERE NOT EXISTS (SELECT 1 FROM vods v WHERE v.id = cm.vod_id)
`);

        if (Number(orphanedChatCheck.rows[0].count) > 0) {
          throw new Error(`${orphanedChatCheck.rows[0].count} chat messages reference non-existent VODs - FK integrity failed`);
        }

        const totalChatMessages = await client.query(`
  SELECT COUNT(*) FROM logs cm
  INNER JOIN "vods_new" vn ON cm.vod_id = vn.vod_id
`);
        const totalChat = Number(totalChatMessages.rows[0].count);

        console.log(`\n📊 Migrating chat messages (${totalChat.toLocaleString()} total)...`);

        const os = await import('os');
        const availableMemoryMB = Math.floor(os.freemem() / 1024 / 1024);
        const suggestedWorkers = Math.min(chatWorkers, Math.floor(availableMemoryMB / 200), 8);
        const actualWorkerCount = Math.max(1, suggestedWorkers);

        console.log(`   Available memory: ${availableMemoryMB} MB`);
        console.log(`   Using ${actualWorkerCount} worker(s) with batch size ${chatBatchSize.toLocaleString()}\n`);

        const chatResult = await migrateChatMessagesParallel(oldPool, client, totalChat, actualWorkerCount, chatBatchSize, vodIdMap, streamerName);

        console.log(`✅ Migrated ${chatResult.processed.toLocaleString()} chat messages\n`);

        const fkCheckResult: any = await client.query(`
          SELECT 
            (SELECT COUNT(*) FROM "emotes_new" e WHERE NOT EXISTS (SELECT 1 FROM "vods_new" v WHERE v.id = e.vod_id)) as emotes_count,
            (SELECT COUNT(*) FROM "games_new" g WHERE NOT EXISTS (SELECT 1 FROM "vods_new" v WHERE v.id = g.vod_id)) as games_count,
            (SELECT COUNT(*) FROM "chapters" c WHERE NOT EXISTS (SELECT 1 FROM "vods_new" v WHERE v.id = c.vod_id)) as chapters_count,
            (SELECT COUNT(*) FROM "vod_uploads" u WHERE NOT EXISTS (SELECT 1 FROM "vods_new" v WHERE v.id = u.vod_id)) as uploads_count,
            (SELECT COUNT(*) FROM "chat_messages_new" c WHERE NOT EXISTS (SELECT 1 FROM "vods_new" v WHERE v.id = c.vod_id)) as chat_count
        `);

        const fkResults = fkCheckResult.rows[0];
        const tableInfo = [
          { name: 'emotes_new', count: Number(fkResults.emotes_count) },
          { name: 'games_new', count: Number(fkResults.games_count) },
          { name: 'chapters', count: Number(fkResults.chapters_count) },
          { name: 'vod_uploads', count: Number(fkResults.uploads_count) },
          { name: 'chat_messages_new', count: Number(fkResults.chat_count) },
        ];

        for (const table of tableInfo) {
          if (table.count > 0) {
            throw new Error(`FK integrity check failed! ${table.count} orphaned records in ${table.name}`);
          }
        }

        console.log('✅ FK integrity validation passed');
        console.log('ℹ️ To clean __typename from chat messages, run: node scripts/cleanup-chat-typenames.js --streamer=<name>\n');

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
        const newChatMessagesCount = await oldPool.query('SELECT COUNT(*) FROM "chat_messages_new"');

        console.log('📊 New database row counts:');
        console.log(`   vods_new: ${newVodsCount.rows[0].count}`);
        console.log(`   vod_uploads: ${newUploadsCount.rows[0].count}`);
        console.log(`   emotes_new: ${newEmotesCount.rows[0].count}`);
        console.log(`   games_new: ${newGamesCount.rows[0].count}`);
        console.log(`   chapters: ${newChaptersCount.rows[0].count}`);
        console.log(`   chat_messages_new: ${newChatMessagesCount.rows[0].count}\n`);

        const renameLegacy = await confirm('Rename legacy tables and finalize migration?');
        if (renameLegacy) {
          try {
            await oldPool.query('ALTER TABLE "vods" RENAME TO "vods_legacy"');
            await oldPool.query('ALTER TABLE "vods_new" RENAME TO "vods"');
            await oldPool.query('ALTER TABLE "emotes" RENAME TO "emotes_legacy"');
            await oldPool.query('ALTER TABLE "emotes_new" RENAME TO "emotes"');
            await oldPool.query('ALTER TABLE "games" RENAME TO "games_legacy"');
            await oldPool.query('ALTER TABLE "games_new" RENAME TO "games"');
            await oldPool.query('ALTER TABLE "logs" RENAME TO "chat_messages_legacy"');
            await oldPool.query('ALTER TABLE "chat_messages_new" RENAME TO "chat_messages"');

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
          await rollbackMigration(client);
          errors.push(`Transaction rolled back due to error: ${String(transactionError)}`);
          console.error('\n❌ Migration failed and rolled back:');
          console.error(transactionError);
        } catch (rollbackError) {
          errors.push(`Failed to rollback transaction: ${String(rollbackError)}`);
          console.error('❌ Rollback also failed:', rollbackError);
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
