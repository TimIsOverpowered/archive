#!/usr/bin/env node
import 'dotenv/config';
import { PrismaClient } from '../../prisma/generated/meta/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { extractErrorDetails } from '../../src/utils/error.js';

const META_DB_URL = process.env.META_DATABASE_URL;
if (!META_DB_URL) {
  console.error('❌ Missing META_DATABASE_URL environment variable');
  process.exit(1);
}

const adapter = new PrismaPg({ connectionString: META_DB_URL });
const metaClient = new PrismaClient({ adapter });

function stripTypename(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(stripTypename);
  if (typeof obj === 'object') {
    const cleaned: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key !== '__typename') cleaned[key] = stripTypename(value);
    }
    return cleaned;
  }
  return obj;
}

function hasTypename(obj: any): boolean {
  if (!obj) return false;
  const str = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return str.includes('__typename');
}

function parseArgs() {
  const args = process.argv.slice(2);
  let streamer: string | null = null;
  let dryRun = false;
  let autoConfirm = false;
  let batchSize = 50000;
  let workers = 4;

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
    } else if (!args[i].startsWith('-')) {
      streamer ||= args[i];
    }
  }

  return { streamer: streamer ?? undefined, dryRun, autoConfirm, batchSize, workers };
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

async function confirm(question: string): Promise<boolean> {
  const answer = await prompt(`${question} [y/N]:`);
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
}

interface WorkerProgress {
  workerId: number;
  processed: number;
  updated: number;
  startTime: number;
  completed: boolean;
}

async function getTableStats(pool: any): Promise<{ pages: number; rowsPerPage: number; estimatedRows: number }> {
  const result = await pool.query(`
    SELECT relpages,
           reltuples,
           ROUND(reltuples / NULLIF(relpages, 0)) as rows_per_page
    FROM pg_class
    WHERE relname = 'chat_messages'
  `);
  const pages = Number(result.rows[0].relpages);
  const estimatedRows = Math.round(Number(result.rows[0].reltuples));
  const rowsPerPage = Math.max(1, Number(result.rows[0].rows_per_page) || 100);
  return { pages, rowsPerPage, estimatedRows };
}

function partitionPageRanges(totalPages: number, workerCount: number): Array<{ startPage: number; endPage: number }> {
  const pagesPerWorker = Math.ceil(totalPages / workerCount);
  return Array.from({ length: workerCount }, (_, i) => ({
    startPage: i * pagesPerWorker,
    endPage: Math.min((i + 1) * pagesPerWorker, totalPages),
  }));
}

async function cleanupWorker(
  pool: any,
  workerId: number,
  startPage: number,
  endPage: number,
  batchSize: number,
  rowsPerPage: number,
  progressCallback: (progress: WorkerProgress) => void
): Promise<{ processed: number; updated: number }> {
  let processed = 0;
  let updated = 0;
  const startTime = Date.now();
  const pagesPerBatch = Math.max(1, Math.ceil(batchSize / rowsPerPage));
  let currentPage = startPage;

  const conn = await pool.connect();
  try {
    while (currentPage < endPage) {
      const batchEndPage = Math.min(currentPage + pagesPerBatch, endPage);

      // Fetch only rows that actually have __typename — no space in path
      const rows: any = await conn.query(
        `SELECT id, message, user_badges
        FROM chat_messages
        WHERE ctid >= CAST(('(' || $1 || ',0)') AS tid)
          AND ctid < CAST(('(' || $2 || ',0)') AS tid)
          AND (message::text LIKE '%__typename%'
            OR user_badges::text LIKE '%__typename%')`,
        [currentPage, batchEndPage]
      );

      currentPage = batchEndPage;

      if (rows.rows.length === 0) {
        progressCallback({ workerId, processed, updated, startTime, completed: false });
        continue;
      }

      const ids: string[] = [];
      const messages: (string | null)[] = [];
      const badges: (string | null)[] = [];

      for (const row of rows.rows) {
        // Only process rows that actually need cleaning
        if (!hasTypename(row.message) && !hasTypename(row.user_badges)) continue;

        const cleanedMessage = row.message ? stripTypename(row.message) : null;
        const cleanedBadges = row.user_badges ? stripTypename(row.user_badges) : null;

        ids.push(row.id);
        messages.push(cleanedMessage ? JSON.stringify(cleanedMessage) : null);
        badges.push(cleanedBadges ? JSON.stringify(cleanedBadges) : null);
        updated++;
      }

      processed += rows.rows.length;

      if (ids.length > 0) {
        // Commit per batch — don't hold a long-running transaction
        await conn.query('BEGIN');
        try {
          await conn.query(
            `UPDATE chat_messages
             SET message = u.message,
                 user_badges = u.user_badges
             FROM (SELECT * FROM UNNEST($1::uuid[], $2::jsonb[], $3::jsonb[])
                   AS t(id, message, user_badges)) AS u
             WHERE chat_messages.id = u.id`,
            [ids, messages, badges]
          );
          await conn.query('COMMIT');
        } catch (err) {
          await conn.query('ROLLBACK');
          throw err;
        }
      }

      progressCallback({ workerId, processed, updated, startTime, completed: false });
    }

    progressCallback({ workerId, processed, updated, startTime, completed: true });
  } finally {
    conn.release();
  }

  return { processed, updated };
}

async function main() {
  console.log('\n🧹 Chat Message __typename Cleanup\n');

  const args = parseArgs();
  const streamerName = args.streamer ?? (await prompt('Streamer name (tenant identifier):'));
  const { dryRun, autoConfirm, batchSize } = args;

  let dbUrl: string;
  try {
    const tenant = await metaClient.tenant.findUnique({
      where: { id: streamerName },
      select: { databaseUrl: true },
    });

    if (!tenant?.databaseUrl) {
      console.error(`❌ Tenant "${streamerName}" not found`);
      process.exit(1);
    }

    const { decryptScalar } = await import('../../src/utils/encryption.js');
    try {
      dbUrl = decryptScalar(tenant.databaseUrl as string);
    } catch (decryptError) {
      console.error('❌ Failed to decrypt database URL:', extractErrorDetails(decryptError).message);
      await metaClient.$disconnect();
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Failed to fetch tenant:', extractErrorDetails(error).message);
    await metaClient.$disconnect();
    process.exit(1);
  }

  try {
    const pg = await import('pg');
    const os = await import('os');
    const availableMemoryMB = Math.floor(os.freemem() / 1024 / 1024);
    const workerCount = Math.max(1, Math.min(args.workers, Math.floor(availableMemoryMB / 200), 8));

    const pool = new pg.Pool({
      connectionString: dbUrl,
      max: workerCount + 2,
    });

    // Register cleanup handler before workers start
    const restoreSettings = async () => {
      console.log('\n🔄 Restoring Postgres settings...');
      try {
        await pool.query(`ALTER SYSTEM SET synchronous_commit = on`);
        await pool.query(`SELECT pg_reload_conf()`);
        console.log('✅ synchronous_commit restored');
      } catch (e) {
        console.warn('⚠️  Run manually: ALTER SYSTEM SET synchronous_commit = on; SELECT pg_reload_conf();');
      }
      try {
        await pool.query(`ALTER TABLE chat_messages SET (autovacuum_enabled = true)`);
        console.log('✅ autovacuum restored');
      } catch (e) {
        console.warn('⚠️  Run manually: ALTER TABLE chat_messages SET (autovacuum_enabled = true);');
      }
    };

    const handleSignal = async (signal: string) => {
      console.log(`\n⚠️  Received ${signal} — cleaning up...`);
      await restoreSettings();
      console.log('✅ Cleanup complete. Workers stopped.\n');
      process.exit(0);
    };

    process.once('SIGINT', () => handleSignal('SIGINT'));
    process.once('SIGTERM', () => handleSignal('SIGTERM'));

    // Apply bulk update optimizations
    console.log('⚡ Optimizing Postgres settings for bulk update...');
    await pool.query(`ALTER TABLE chat_messages SET (autovacuum_enabled = false)`);
    await pool.query(`ALTER SYSTEM SET synchronous_commit = off`);
    await pool.query(`SELECT pg_reload_conf()`);
    console.log('✅ Settings applied\n');

    // Get table stats — no expensive COUNT(*) scan
    let tableStats: { pages: number; rowsPerPage: number; estimatedRows: number };
    try {
      tableStats = await getTableStats(pool);
    } catch (err) {
      if (String(err).includes('does not exist')) {
        console.log('ℹ️  chat_messages table does not exist — nothing to clean\n');
        await pool.end();
        await metaClient.$disconnect();
        process.exit(0);
      }
      throw err;
    }

    if (tableStats.estimatedRows === 0) {
      console.log('ℹ️  No rows in chat_messages — nothing to clean\n');
      await pool.end();
      await metaClient.$disconnect();
      process.exit(0);
    }

    // Quick text scan to check if any __typename exists at all
    // Uses LIKE on text cast which is faster than jsonb_path_exists for existence check
    const quickCheck = await pool.query(`
      SELECT EXISTS (
        SELECT 1 FROM chat_messages
        WHERE message::text LIKE '%__typename%'
           OR user_badges::text LIKE '%__typename%'
        LIMIT 1
      ) as has_typename
    `);

    if (!quickCheck.rows[0].has_typename) {
      console.log('ℹ️  No __typename fields found — nothing to clean\n');
      await pool.end();
      await metaClient.$disconnect();
      process.exit(0);
    }

    console.log(`🎯 Streamer: ${streamerName}`);
    console.log(`   Estimated rows: ${tableStats.estimatedRows.toLocaleString()}`);
    console.log(`   Heap pages: ${tableStats.pages.toLocaleString()}`);
    console.log(`   Rows/page: ~${tableStats.rowsPerPage}`);
    console.log(`   Workers: ${workerCount}`);
    console.log(`   Batch size: ${batchSize.toLocaleString()}`);
    console.log(`   Dry run: ${dryRun ? 'YES' : 'NO'}\n`);

    if (dryRun) {
      console.log('✅ Dry run complete — __typename fields detected, would proceed with cleanup\n');
      await pool.end();
      await metaClient.$disconnect();
      return;
    }

    if (!autoConfirm) {
      const proceed = await confirm('Proceed with cleanup?');
      if (!proceed) {
        console.log('❌ Cancelled\n');
        await pool.end();
        await metaClient.$disconnect();
        process.exit(0);
      }
    }

    const globalStartTime = Date.now();
    const partitions = partitionPageRanges(tableStats.pages, workerCount);

    const workerProgress: WorkerProgress[] = Array.from({ length: workerCount }, (_, i) => ({
      workerId: i + 1,
      processed: 0,
      updated: 0,
      startTime: globalStartTime,
      completed: false,
    }));

    const updateProgress = (progress: WorkerProgress) => {
      const idx = workerProgress.findIndex((wp) => wp.workerId === progress.workerId);
      if (idx !== -1) workerProgress[idx] = progress;
    };

    const displayProgress = () => {
      const now = Date.now();
      const elapsedSec = Math.floor((now - globalStartTime) / 1000);
      const elapsedMins = Math.floor(elapsedSec / 60);
      const elapsedSecs = elapsedSec % 60;
      const elapsedStr = `${elapsedMins.toString().padStart(2, '0')}:${elapsedSecs.toString().padStart(2, '0')}`;

      const totalProcessed = workerProgress.reduce((sum, wp) => sum + wp.processed, 0);
      const totalUpdated = workerProgress.reduce((sum, wp) => sum + wp.updated, 0);
      const overallPercent = tableStats.estimatedRows > 0 ? (totalProcessed / tableStats.estimatedRows) * 100 : 0;
      const rate = elapsedSec > 0 ? totalProcessed / elapsedSec : 0;

      let etaStr = '--:--';
      if (rate > 0 && totalProcessed < tableStats.estimatedRows) {
        const remainingSec = Math.ceil((tableStats.estimatedRows - totalProcessed) / rate);
        etaStr = `${Math.floor(remainingSec / 60)
          .toString()
          .padStart(2, '0')}:${(remainingSec % 60).toString().padStart(2, '0')}`;
      }

      console.log('\x1B[2J\x1B[H');
      console.log(`🧹 Cleaning chat messages for "${streamerName}"\n`);
      console.log(`   Started: ${new Date(globalStartTime).toLocaleTimeString()}`);
      console.log(`   Elapsed: ${elapsedStr} | ETA: ${etaStr}\n`);

      workerProgress.forEach((wp) => {
        const workerRate = elapsedSec > 0 ? wp.processed / elapsedSec : 0;
        const status = wp.completed ? ' ✓' : '';
        const rateStr = workerRate > 0 ? ` (${workerRate.toFixed(1)}/s)` : '';
        console.log(`   Worker ${wp.workerId}: ${wp.processed.toLocaleString()} scanned, ${wp.updated.toLocaleString()} updated${status}${rateStr}`);
      });

      console.log('   ─────────────────────────────────────────────');
      console.log(
        `   Total: ${totalProcessed.toLocaleString()}/${tableStats.estimatedRows.toLocaleString()} (${overallPercent.toFixed(1)}%) | Updated: ${totalUpdated.toLocaleString()} | Rate: ${rate.toFixed(1)}/s\n`
      );
    };

    // Apply bulk update optimizations
    console.log('⚡ Optimizing Postgres settings for bulk update...');
    await pool.query(`ALTER TABLE chat_messages SET (autovacuum_enabled = false)`);
    await pool.query(`ALTER SYSTEM SET synchronous_commit = off`);
    await pool.query(`SELECT pg_reload_conf()`);
    console.log('✅ Settings applied\n');

    let results: { processed: number; updated: number }[];
    try {
      const progressInterval = setInterval(displayProgress, 1000);
      try {
        results = await Promise.all(partitions.map((partition, i) => cleanupWorker(pool, i + 1, partition.startPage, partition.endPage, batchSize, tableStats.rowsPerPage, updateProgress)));
        clearInterval(progressInterval);
        displayProgress();
      } catch (err) {
        clearInterval(progressInterval);
        throw err;
      }
    } finally {
      console.log('\n🔄 Restoring Postgres settings...');
      try {
        await pool.query(`ALTER SYSTEM SET synchronous_commit = on`);
        await pool.query(`SELECT pg_reload_conf()`);
        console.log('✅ synchronous_commit restored');
      } catch (e) {
        console.warn('⚠️  Failed to restore synchronous_commit — run manually: ALTER SYSTEM SET synchronous_commit = on; SELECT pg_reload_conf();');
      }
      try {
        await pool.query(`ALTER TABLE chat_messages SET (autovacuum_enabled = true)`);
        console.log('✅ autovacuum restored');
      } catch (e) {
        console.warn('⚠️  Failed to restore autovacuum — run manually: ALTER TABLE chat_messages SET (autovacuum_enabled = true);');
      }
      console.log('🧹 Scheduling post-cleanup vacuum (non-blocking)...');
      try {
        pool.query(`VACUUM ANALYZE chat_messages`).catch(() => {});
        console.log('✅ VACUUM ANALYZE scheduled\n');
      } catch (e) {
        console.warn('⚠️  Failed to schedule vacuum — run manually: VACUUM ANALYZE chat_messages;');
      }
    }

    const totalProcessed = results.reduce((sum, r) => sum + r.processed, 0);
    const totalUpdated = results.reduce((sum, r) => sum + r.updated, 0);

    console.log('📋 Final Results:');
    console.log(`   Scanned: ${totalProcessed.toLocaleString()}`);
    console.log(`   Updated: ${totalUpdated.toLocaleString()}`);
    console.log(`   Workers: ${workerCount}\n`);
    console.log('🎉 Cleanup completed successfully!\n');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('ECONNREFUSED')) {
      console.error('❌ Cannot connect to database');
    } else if ((error as any)?.code === '28P01') {
      console.error('❌ Authentication failed');
    } else {
      console.error('❌ Error:', msg);
    }
    await metaClient.$disconnect();
    process.exit(1);
  }

  await metaClient.$disconnect();
}

main();
