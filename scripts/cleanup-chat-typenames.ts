#!/usr/bin/env node
import 'dotenv/config';
import { PrismaClient } from '../prisma/generated/meta/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { extractErrorDetails } from '../src/utils/error.js';

const META_DB_URL = process.env.META_DATABASE_URL;
if (!META_DB_URL) {
  console.error('❌ Missing META_DATABASE_URL environment variable');
  process.exit(1);
}

const adapter = new PrismaPg({ connectionString: META_DB_URL });
const metaClient = new PrismaClient({ adapter });

function stripTypename(obj: any): any {
  if (obj === null || obj === undefined) return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => stripTypename(item));
  }

  if (typeof obj === 'object') {
    const cleaned: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key !== '__typename') {
        cleaned[key] = stripTypename(value);
      }
    }
    return cleaned;
  }

  return obj;
}

function parseArgs(): {
  streamer?: string | null;
  dryRun: boolean;
  autoConfirm: boolean;
  batchSize?: number;
  workers?: number;
  parallel: boolean;
} {
  const args = process.argv.slice(2);
  let streamer: string | null = null;
  let dryRun = false;
  let autoConfirm = false;
  let batchSize = 100000;
  let workers = 4;
  let parallel = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--streamer' && args[i + 1]) {
      streamer ||= args[++i];
    } else if (args[i].startsWith('--streamer=')) {
      streamer ||= args[i].slice('--streamer='.length);
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--yes' || args[i] === '-y') {
      autoConfirm = true;
    } else if (args[i] === '--batch-size' && args[i + 1]) {
      batchSize = parseInt(args[++i], 10);
    } else if (args[i].startsWith('--batch-size=')) {
      batchSize = parseInt(args[i].slice('--batch-size='.length), 10);
    } else if (args[i] === '--workers' && args[i + 1]) {
      workers = parseInt(args[++i], 10);
    } else if (args[i].startsWith('--workers=')) {
      workers = parseInt(args[i].slice('--workers='.length), 10);
    } else if (args[i] === '--parallel') {
      parallel = true;
    } else if (!args[i].startsWith('-')) {
      streamer ||= args[i];
    }
  }

  return { streamer: streamer || undefined, dryRun, autoConfirm, batchSize, workers, parallel };
}

async function prompt(question: string): Promise<string> {
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    rl.question(`${question} `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
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

interface WorkerProgress {
  workerId: number;
  processed: number;
  updated: number;
  target: number;
  startTime: number;
  completed: boolean;
}

async function cleanupRange(
  pool: any,
  range: { min: string; max: string },
  workerId: number,
  batchSize: number,
  rangeAffectedCount: number,
  progressCallback: (progress: WorkerProgress) => void
): Promise<{ processed: number; updated: number }> {
  const conn = await pool.connect();
  let processed = 0;
  let updated = 0;
  const startTime = Date.now();
  let completed = false;

  try {
    await conn.query('BEGIN;');

    await conn.query(
      `DECLARE cleanup_cursor CURSOR FOR 
      SELECT id, message, user_badges 
      FROM "chat_messages" 
      WHERE id >= $1::uuid AND id <= $2::uuid
        AND (jsonb_path_exists(message, '$.**. __typename')
            OR jsonb_path_exists(user_badges, '$.**. __typename'))
      ORDER BY id;`,
      [range.min, range.max]
    );

    try {
      while (true) {
        const rows: any = await conn.query(`FETCH FORWARD ${batchSize} IN cleanup_cursor;`);

        if (rows.rows.length === 0) break;

        const ids: string[] = [];
        const messages: (string | null)[] = [];
        const badges: (string | null)[] = [];

        for (const row of rows.rows) {
          const cleanedMessage = row.message ? stripTypename(row.message) : null;
          const cleanedBadges = row.user_badges ? stripTypename(row.user_badges) : null;

          const messageJson = cleanedMessage ? JSON.stringify(cleanedMessage) : null;
          const badgesJson = cleanedBadges ? JSON.stringify(cleanedBadges) : null;

          const originalMessage = row.message ? JSON.stringify(row.message) : null;
          const originalBadges = row.user_badges ? JSON.stringify(row.user_badges) : null;

          if (messageJson !== originalMessage || badgesJson !== originalBadges) {
            ids.push(row.id);
            messages.push(messageJson);
            badges.push(badgesJson);
            updated++;
          }
        }

        processed += rows.rows.length;

        if (ids.length > 0) {
          await conn.query(
            `UPDATE "chat_messages" 
             SET message = u.message, user_badges = u.user_badges
             FROM (SELECT * FROM UNNEST($1::uuid[], $2::jsonb[], $3::jsonb[]) AS t(id, message, user_badges)) AS u
             WHERE "chat_messages".id = u.id`,
            [ids, messages, badges]
          );
        }

        progressCallback({ workerId, processed, updated, target: rangeAffectedCount, startTime, completed });
      }

      completed = true;
      progressCallback({ workerId, processed, updated, target: rangeAffectedCount, startTime, completed });
    } finally {
      await conn.query('CLOSE cleanup_cursor;');
    }

    await conn.query('COMMIT;');
  } catch (error) {
    try {
      await conn.query('ROLLBACK;');
    } catch (rollbackError) {}
    throw error;
  } finally {
    conn.release();
  }

  return { processed, updated };
}

async function cleanupSingleThreaded(pool: any, batchSize: number, affectedCount: number, streamerName: string): Promise<{ processed: number; updated: number }> {
  const conn = await pool.connect();
  let processed = 0;
  let updated = 0;
  const startTime = Date.now();

  try {
    await conn.query('BEGIN;');

    await conn.query(`DECLARE cleanup_cursor CURSOR FOR 
      SELECT id, message, user_badges 
      FROM "chat_messages" 
      WHERE jsonb_path_exists(message, '$.**. __typename')
         OR jsonb_path_exists(user_badges, '$.**. __typename')
      ORDER BY id;`);

    try {
      const displayProgress = () => {
        const now = Date.now();
        const elapsedSec = Math.floor((now - startTime) / 1000);
        const elapsedMins = Math.floor(elapsedSec / 60);
        const elapsedSecs = elapsedSec % 60;
        const elapsedStr = `${elapsedMins.toString().padStart(2, '0')}:${elapsedSecs.toString().padStart(2, '0')}`;

        const percent = affectedCount > 0 ? (processed / affectedCount) * 100 : 0;
        const rate = elapsedSec > 0 ? processed / elapsedSec : 0;

        let etaStr = '--:--';
        if (rate > 0 && processed < affectedCount) {
          const remaining = affectedCount - processed;
          const remainingSec = Math.ceil(remaining / rate);
          const remainingMins = Math.floor(remainingSec / 60);
          const remainingSecs = remainingSec % 60;
          etaStr = `${remainingMins.toString().padStart(2, '0')}:${remainingSecs.toString().padStart(2, '0')}`;
        }

        console.log('\x1B[2J\x1B[H');
        console.log(`🔄 Cleaning chat messages for "${streamerName}"\n`);
        console.log(`   Started: ${new Date(startTime).toLocaleTimeString()}`);
        console.log(`   Elapsed: ${elapsedStr} | ETA: ${etaStr}\n`);
        console.log(`   Progress: ${processed.toLocaleString()}/${affectedCount.toLocaleString()} (${percent.toFixed(1)}%)`);
        console.log(`   Updated: ${updated.toLocaleString()} | Rate: ${rate.toFixed(1)}/s\n`);
      };

      const progressInterval = setInterval(displayProgress, 1000);

      while (true) {
        const rows: any = await conn.query(`FETCH FORWARD ${batchSize} IN cleanup_cursor;`);

        if (rows.rows.length === 0) break;

        const ids: string[] = [];
        const messages: (string | null)[] = [];
        const badges: (string | null)[] = [];

        for (const row of rows.rows) {
          const cleanedMessage = row.message ? stripTypename(row.message) : null;
          const cleanedBadges = row.user_badges ? stripTypename(row.user_badges) : null;

          const messageJson = cleanedMessage ? JSON.stringify(cleanedMessage) : null;
          const badgesJson = cleanedBadges ? JSON.stringify(cleanedBadges) : null;

          const originalMessage = row.message ? JSON.stringify(row.message) : null;
          const originalBadges = row.user_badges ? JSON.stringify(row.user_badges) : null;

          if (messageJson !== originalMessage || badgesJson !== originalBadges) {
            ids.push(row.id);
            messages.push(messageJson);
            badges.push(badgesJson);
            updated++;
          }
        }

        processed += rows.rows.length;

        if (ids.length > 0) {
          await conn.query(
            `UPDATE "chat_messages" 
             SET message = u.message, user_badges = u.user_badges
             FROM (SELECT * FROM UNNEST($1::uuid[], $2::jsonb[], $3::jsonb[]) AS t(id, message, user_badges)) AS u
             WHERE "chat_messages".id = u.id`,
            [ids, messages, badges]
          );
        }
      }

      clearInterval(progressInterval);
      displayProgress();
    } finally {
      await conn.query('CLOSE cleanup_cursor;');
    }

    await conn.query('COMMIT;');
  } catch (error) {
    try {
      await conn.query('ROLLBACK;');
    } catch (rollbackError) {}
    throw error;
  } finally {
    conn.release();
  }

  return { processed, updated };
}

async function main() {
  console.log('\n🧹 Chat Message __typename Cleanup Script (Optimized with Parallel Support)\n');

  const args = parseArgs();
  let streamerName: string | null;

  if (args.streamer !== undefined) {
    streamerName = args.streamer || '';
  } else {
    streamerName = await prompt('Streamer name (tenant identifier): ');
  }

  const dryRunMode = args.dryRun;
  const autoConfirm = args.autoConfirm;
  const batchSize = args.batchSize || 100000;
  const requestedWorkers = args.workers || 4;
  const parallelRequested = args.parallel;

  let dbUrl: string | null;
  try {
    const tenant = await metaClient.tenant.findUnique({
      where: { id: streamerName },
      select: { databaseUrl: true },
    });

    if (!tenant?.databaseUrl) {
      console.error(`\n❌ Tenant "${streamerName}" not found in meta database`);
      process.exit(1);
    }

    const { decryptScalar } = await import('../src/utils/encryption');

    try {
      dbUrl = decryptScalar(tenant.databaseUrl as string);
    } catch (decryptError) {
      const details = extractErrorDetails(decryptError);
      console.error('\n❌ Failed to decrypt database URL:', details.message);
      await metaClient.$disconnect();
      process.exit(1);
    }
  } catch (error) {
    const details = extractErrorDetails(error);
    console.error(`\n❌ Failed to fetch tenant from meta database: ${details.message}`);
    await metaClient.$disconnect();
    process.exit(1);
  }

  const os = await import('os');
  const availableMemory = Math.floor(os.freemem() / 1024 / 1024);
  const suggestedWorkers = Math.min(requestedWorkers, Math.floor(availableMemory / 200), 8);

  console.log(`🎯 Cleaning chat messages for: ${streamerName}`);
  console.log(`   Database URL: ${dbUrl.replace(/\/\/.*@/, '//***:***@')}`);
  console.log(`   Batch size: ${batchSize.toLocaleString()}`);
  console.log(`   Available memory: ${availableMemory} MB`);
  console.log(`   Suggested workers: ${suggestedWorkers} (requested: ${requestedWorkers})`);
  console.log(`   Dry run mode: ${dryRunMode ? 'YES' : 'NO'}\n`);

  const errors: string[] = [];

  try {
    const pg = await import('pg');
    const pool = new pg.Pool({ connectionString: dbUrl });

    let totalRecords: number | null = null;
    let affectedCount: number | null = null;

    try {
      const statsResult: any = await pool.query(`
        SELECT 
          c.reltuples as estimated_total_rows,
          s.n_live_tup as live_tuple_estimate
        FROM pg_class c
        LEFT JOIN pg_stat_user_tables s ON c.relname = s.relname
        WHERE c.relname = 'chat_messages'
      `);

      const rowCountValue: number | null = statsResult.rows[0].live_tuple_estimate ?? statsResult.rows[0].estimated_total_rows;
      totalRecords = rowCountValue !== null ? Math.round(rowCountValue) : null;

      console.log('📊 Table statistics:');
      console.log(`   Estimated total rows in chat_messages: ${totalRecords ? totalRecords.toLocaleString() : 'unknown'}`);
      console.log(`   (Using PostgreSQL vacuum statistics - actual count may vary by ~10%)\n`);
    } catch (countError) {
      errors.push(`Failed to get table statistics: ${String(countError)}`);

      if ((countError as any)?.message?.includes('relation "chat_messages" does not exist')) {
        console.log('\nℹ️  chat_messages table does not exist - nothing to clean\n');

        await pool.end();
        await metaClient.$disconnect();
        process.exit(0);
      } else {
        throw countError;
      }
    }

    if (totalRecords === null || totalRecords === 0) {
      console.log('\nℹ️ No records found in chat_messages table\n');

      await pool.end();
      await metaClient.$disconnect();
      process.exit(0);
    }

    try {
      const affectedCheck = await pool.query(`
        SELECT COUNT(*) FROM chat_messages 
        WHERE jsonb_path_exists(message, '$.**. __typename')
           OR jsonb_path_exists(user_badges, '$.**. __typename')
      `);
      affectedCount = Number(affectedCheck.rows[0].count);

      console.log(`📊 Affected records: ${affectedCount.toLocaleString()} contain __typename\n`);
    } catch (affectedError) {
      errors.push(`Failed to count affected records: ${String(affectedError)}`);
      throw affectedError;
    }

    if (affectedCount === 0) {
      console.log('\nℹ️ No chat messages contain __typename fields - nothing to clean\n');

      await pool.end();
      await metaClient.$disconnect();
      process.exit(0);
    }

    if (dryRunMode) {
      console.log(`\n✅ Dry run complete`);
      console.log(`   Would clean: ${affectedCount.toLocaleString()} records\n`);

      await pool.end();
      await metaClient.$disconnect();
      return;
    }

    let useParallel = parallelRequested;

    if (!useParallel && suggestedWorkers > 1 && affectedCount > 500000) {
      const parallelAnswer = await prompt(`Parallel cleanup recommended for ${affectedCount.toLocaleString()} records. Use ${suggestedWorkers} workers (~${suggestedWorkers * 150} MB RAM)? [y/N]: `);
      useParallel = parallelAnswer.toLowerCase() === 'y' || parallelAnswer.toLowerCase() === 'yes';
    }

    if (!useParallel && !parallelRequested) {
      const parallelAnswer = await prompt('\nUse parallel cleanup? (faster, uses more memory) [y/N]: ');
      useParallel = parallelAnswer.toLowerCase() === 'y' || parallelAnswer.toLowerCase() === 'yes';
    }

    if (useParallel) {
      let workerCount = suggestedWorkers;

      if (!autoConfirm) {
        const workerAnswer = await prompt(`Number of workers? [${workerCount}]: `);
        if (workerAnswer && workerAnswer.trim()) {
          const parsed = parseInt(workerAnswer, 10);
          if (!isNaN(parsed) && parsed >= 2 && parsed <= 8) {
            workerCount = parsed;
          } else {
            console.log(`Invalid value. Using ${workerCount} workers.`);
          }
        }
      }

      const memoryRequired = workerCount * 150;
      if (availableMemory < memoryRequired) {
        console.log(`\n⚠️  Warning: Only ${availableMemory} MB free, but ${memoryRequired} MB recommended for ${workerCount} workers`);
        const proceed = await prompt('Continue anyway? [y/N]: ');
        if (proceed.toLowerCase() !== 'y' && proceed.toLowerCase() !== 'yes') {
          console.log('\n❌ Cleanup cancelled by user\n');
          await pool.end();
          await metaClient.$disconnect();
          process.exit(0);
        }
      }

      const confirmAnswer = autoConfirm ? 'y' : await prompt('\nProceed with parallel cleanup? [y/N]: ');

      if (confirmAnswer.toLowerCase() !== 'y' && confirmAnswer.toLowerCase() !== 'yes') {
        console.log('\n❌ Cleanup cancelled by user\n');

        await pool.end();
        await metaClient.$disconnect();
        process.exit(0);
      }

      console.log(`\n🔄 Starting parallel cleanup with ${workerCount} workers...\n`);

      const ranges = getUuidRanges(workerCount);
      const rangeAffectedCount = Math.ceil(affectedCount / workerCount);
      const globalStartTime = Date.now();

      const workerProgress: WorkerProgress[] = ranges.map((_, i) => ({
        workerId: i + 1,
        processed: 0,
        updated: 0,
        target: rangeAffectedCount,
        startTime: globalStartTime,
        completed: false,
      }));

      const updateProgress = (progress: WorkerProgress) => {
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
        const totalTarget = workerProgress.reduce((sum, wp) => sum + wp.target, 0);
        const overallPercent = totalTarget > 0 ? (totalProcessed / totalTarget) * 100 : 0;

        let overallRate = 0;
        if (elapsedSec > 0) {
          overallRate = totalProcessed / elapsedSec;
        }

        let etaStr = '--:--';
        if (overallRate > 0 && totalProcessed < totalTarget) {
          const remaining = totalTarget - totalProcessed;
          const remainingSec = Math.ceil(remaining / overallRate);
          const remainingMins = Math.floor(remainingSec / 60);
          const remainingSecs = remainingSec % 60;
          etaStr = `${remainingMins.toString().padStart(2, '0')}:${remainingSecs.toString().padStart(2, '0')}`;
        }

        console.log('\x1B[2J\x1B[H');
        console.log(`🔄 Cleaning chat messages for "${streamerName}"\n`);
        console.log(`   Started: ${new Date(globalStartTime).toLocaleTimeString()}`);
        console.log(`   Elapsed: ${elapsedStr} | ETA: ${etaStr}\n`);

        workerProgress.forEach((wp) => {
          const percent = wp.target > 0 ? (wp.processed / wp.target) * 100 : 0;
          const workerElapsed = Math.floor((now - wp.startTime) / 1000);
          const workerRate = workerElapsed > 0 ? wp.processed / workerElapsed : 0;
          const status = wp.completed ? '✓' : '';
          const rateStr = workerRate > 0 ? ` (${workerRate.toFixed(1)}/s)` : '';
          console.log(`   Worker ${wp.workerId}: ${wp.processed.toLocaleString()}/${wp.target.toLocaleString()} (${percent.toFixed(1)}%) ${status}${rateStr}`);
        });

        console.log('   ─────────────────────────────────────────────');
        console.log(`   Total: ${totalProcessed.toLocaleString()}/${totalTarget.toLocaleString()} (${overallPercent.toFixed(1)}%) | Rate: ${overallRate.toFixed(1)}/s\n`);
      };

      const progressInterval = setInterval(displayProgress, 1000);

      const results = await Promise.all(ranges.map((range, i) => cleanupRange(pool, range, i + 1, batchSize, rangeAffectedCount, updateProgress)));

      clearInterval(progressInterval);
      displayProgress();

      const totalUpdated = results.reduce((sum, r) => sum + r.updated, 0);

      console.log('\n📋 Final Results:');
      console.log(`   Total processed: ${workerProgress.reduce((sum, wp) => sum + wp.processed, 0).toLocaleString()}`);
      console.log(`   Total updated: ${totalUpdated.toLocaleString()}`);
      console.log(`   Workers used: ${workerCount}\n`);
    } else {
      const confirmAnswer = autoConfirm ? 'y' : await prompt('\nProceed with single-threaded cleanup? [y/N]: ');

      if (confirmAnswer.toLowerCase() !== 'y' && confirmAnswer.toLowerCase() !== 'yes') {
        console.log('\n❌ Cleanup cancelled by user\n');

        await pool.end();
        await metaClient.$disconnect();
        process.exit(0);
      }

      console.log(`\n🔄 Starting single-threaded cleanup...\n`);

      const { processed, updated } = await cleanupSingleThreaded(pool, batchSize, affectedCount, streamerName);

      console.log('\n📋 Final Results:');
      console.log(`   Total processed: ${processed.toLocaleString()}`);
      console.log(`   Total updated: ${updated.toLocaleString()}`);
      console.log(`   Mode: Single-threaded\n`);
    }

    await pool.end();
    await metaClient.$disconnect();

    if (errors.length > 0) {
      console.log('\n⚠️ Completed with warnings:\n');
      errors.forEach((err, i) => console.log(`   ${i + 1}. ${err}`));
      console.log('');
      process.exit(1);
    } else {
      console.log('🎉 Cleanup completed successfully!\n');
    }
  } catch (error: unknown) {
    errors.push(`Operation failed: ${String(error)}`);

    const isConnectionError = typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' && error.message.includes('ECONNREFUSED');

    if (isConnectionError) {
      console.error('\n❌ Cannot connect to database. Check that the connection string is valid and server is running.');
    } else if (typeof error === 'object' && error !== null && 'code' in error && error.code === '28P01') {
      console.error('\n❌ Authentication failed for database user.');
    } else {
      const message = typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error);
    }

    await metaClient.$disconnect();

    if (errors.length > 0) {
      console.log('\n⚠️ Errors encountered:\n');
      errors.forEach((err, i) => console.log(`   ${i + 1}. ${err}`));
      console.log('');
    }

    process.exit(1);
  }
}

main();
