#!/usr/bin/env node
import 'dotenv/config';
import { PrismaClient } from '../prisma/generated/meta/index.js';
import { PrismaPg } from '@prisma/adapter-pg';

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

function parseArgs(): { streamer?: string | null; dryRun: boolean; autoConfirm: boolean } {
  const args = process.argv.slice(2);
  let streamer: string | null = null;
  let dryRun = false;
  let autoConfirm = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--streamer' && args[i + 1]) {
      streamer ||= args[++i];
    } else if (args[i].startsWith('--streamer=')) {
      streamer ||= args[i].slice('--streamer='.length);
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--yes' || args[i] === '-y') {
      autoConfirm = true;
    } else if (!args[i].startsWith('-')) {
      streamer ||= args[i];
    }
  }

  return { streamer: streamer || undefined, dryRun, autoConfirm };
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

async function main() {
  console.log('\n🧹 Chat Message __typename Cleanup Script\n');

  const args = parseArgs();
  let streamerName: string | null;

  if (args.streamer !== undefined) {
    streamerName = args.streamer || '';
  } else {
    streamerName = await prompt('Streamer name (tenant identifier): ');
  }

  const dryRunMode = args.dryRun;
  const autoConfirm = args.autoConfirm;

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
      console.error('\n❌ Failed to decrypt database URL:', String(decryptError));
      await metaClient.$disconnect();
      process.exit(1);
    }
  } catch (error) {
    console.error(`\n❌ Failed to fetch tenant from meta database: ${String(error)}`);
    await metaClient.$disconnect();
    process.exit(1);
  }

  const BATCH_SIZE = 10000;

  console.log(`🎯 Cleaning chat messages for: ${streamerName}`);
  console.log(`   Database URL: ${dbUrl.replace(/\/\/.*@/, '//***:***@')}`);
  console.log(`   Batch size: ${BATCH_SIZE.toLocaleString()}`);
  console.log(`   Dry run mode: ${dryRunMode ? 'YES' : 'NO'}\n`);

  const errors: string[] = [];

  try {
    const pg = await import('pg');
    const pool = new pg.Pool({ connectionString: dbUrl });

    let totalRecords: number | null = null;
    let affectedRecordsEstimate: number | null = null;

    try {
      // Get approximate row count from PostgreSQL statistics (instant, no table scan)
      const statsResult: any = await pool.query(`
        SELECT 
          c.reltuples as estimated_total_rows,
          s.n_live_tup as live_tuple_estimate
        FROM pg_class c
        LEFT JOIN pg_stat_user_tables s ON c.relname = s.relname
        WHERE c.relname = 'chat_messages'
      `);

      // Get the row count from PostgreSQL statistics  
      const rowCountValue: number | null = statsResult.rows[0].live_tuple_estimate ?? statsResult.rows[0].estimated_total_rows;
      
      totalRecords = rowCountValue !== null ? Math.round(rowCountValue) : null;

      if (totalRecords && totalRecords > 0) {
        affectedRecordsEstimate = Math.round(totalRecords * 0.95);
      }

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

    if (dryRunMode) {
      console.log(`\n✅ Dry run complete - will scan for __typename fields`);
      console.log('   Note: Actual affected count determined during cursor processing\n');

      const poolEnded = await pool.end();
      await metaClient.$disconnect();
      return;
    }

    const confirmAnswer = autoConfirm ? 'y' : await prompt('\nProceed with cleanup? [y/N]: ');

    if (confirmAnswer.toLowerCase() !== 'y' && confirmAnswer.toLowerCase() !== 'yes') {
      console.log('\n❌ Cleanup cancelled by user\n');

      await pool.end();
      await metaClient.$disconnect();
      process.exit(0);
    }

    let processedCount = 0;
    let updatedCount = 0;
    let batchNum = 0;

    console.log('\n🔄 Starting cleanup with server-side cursor...\n');

    // Use dedicated connection for cursor operations to avoid pool interference
    const conn = await pool.connect();

    try {
      // Begin transaction block - required for DECLARE CURSOR in PostgreSQL
      await conn.query('BEGIN;');

      // Declare a named cursor that filters only records containing __typename
      await conn.query(`DECLARE cleanup_cursor CURSOR FOR 
        SELECT id, message, user_badges 
        FROM chat_messages 
        WHERE message::text LIKE '%__typename%' OR user_badges::text LIKE '%__typename%';`);

      while (true) {
        // Fetch next batch from cursor - O(1) performance regardless of position
        const results: any = await conn.query(`FETCH FORWARD ${BATCH_SIZE} IN cleanup_cursor;`);

        if (results.rows.length === 0) break; // Cursor exhausted

        batchNum++;

        for (const row of results.rows) {
          const newMessage = stripTypename(row.message);
          const newUserBadges = stripTypename(row.user_badges);

          // Convert to JSON strings for PostgreSQL storage
          const messageJson = newMessage ? JSON.stringify(newMessage) : null;
          const badgesJson = newUserBadges !== undefined && newUserBadges !== null ? JSON.stringify(newUserBadges) : null;

          const originalMessageJson = row.message ? JSON.stringify(row.message) : null;
          const originalBadgesJson = row.user_badges ? JSON.stringify(row.user_badges) : null;

          if (messageJson !== originalMessageJson || badgesJson !== originalBadgesJson) {
            await conn.query(
              `UPDATE chat_messages 
                SET message = $2, user_badges = $3::jsonb
                WHERE id = $1`,
              [row.id, messageJson, badgesJson]
            );
            updatedCount++;
          }

          processedCount++;
        }

        // Show progress without percentage since we don't have exact affected count upfront
        console.log(`🔄 Batch ${batchNum}: Processed ${processedCount.toLocaleString()} records (Updated: ${updatedCount.toLocaleString()})`);
      }

      // Commit all changes at the end of cursor processing
      await conn.query('COMMIT;');

      console.log('');
    } catch (cursorError) {
      try {
        await conn.query('ROLLBACK;');
        console.log('\n⚠️ Transaction rolled back due to error\n');
      } catch (rollbackError) {}

      throw cursorError;
    } finally {
      conn.release();
    }

    console.log('\n📋 Final Results:');
    console.log(`   Total processed: ${processedCount.toLocaleString()}`);
    console.log(`   Records updated: ${updatedCount.toLocaleString()}`);
    console.log(`   Unchanged/skipped: ${(processedCount - updatedCount).toLocaleString()}\n`);

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
  } catch (error: any) {
    errors.push(`Operation failed: ${String(error)}`);

    if ((error as any)?.message?.includes('ECONNREFUSED')) {
      console.error('\n❌ Cannot connect to database. Check that the connection string is valid and server is running.');
    } else if (error.code === '28P01') {
      console.error('\n❌ Authentication failed for database user.');
    } else {
      console.error(`\n❌ Database error: ${error.message}`);
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
