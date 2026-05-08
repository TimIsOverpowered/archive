#!/usr/bin/env node

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';
import { initMetaClient, closeMetaClient } from '../src/db/meta-client.js';
import type { InsertableTenants } from '../src/db/meta-types.js';
import { getTenantById, createTenant, deleteTenant } from '../src/services/meta-tenants.service.js';
import { validateEncryptionKey } from '../src/utils/encryption.js';
import { extractErrorDetails } from '../src/utils/error.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Validate encryption key at startup
if (!process.env.ENCRYPTION_MASTER_KEY || !validateEncryptionKey(process.env.ENCRYPTION_MASTER_KEY)) {
  console.error('❌ ENCRYPTION_MASTER_KEY must be a valid 32-byte hex string (64 hex characters)');
  console.error('   Set it in your .env file before running this script.');
  process.exit(1);
}

if (!process.env.META_DATABASE_URL) {
  console.error('❌ META_DATABASE_URL must be set in your .env file');
  process.exit(1);
}

// Validate PostgreSQL connection before starting prompts
async function validatePostgresConnection(
  host: string,
  port: number,
  user: string,
  password: string
): Promise<boolean> {
  try {
    const pool = new Pool({
      host,
      port,
      user,
      password,
      database: 'postgres', // Connect to default postgres DB
    });

    await pool.query('SELECT 1');
    pool.end();
    return true;
  } catch (error) {
    const details = extractErrorDetails(error);
    console.error(`❌ Cannot connect to PostgreSQL server at ${host}:${port}`);
    console.error(`   Error: ${details.message}`);
    return false;
  }
}

// Interactive prompts - create fresh readline interface for each prompt to avoid duplication issues
function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(question + ': ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(question + ' (shown in plain text): ', (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(`${question} (y/N): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

interface DatabaseResult {
  success: boolean;
  isNew: boolean;
}

// Database operations
async function createDatabase(
  host: string,
  port: number,
  user: string,
  password: string,
  dbName: string
): Promise<DatabaseResult> {
  try {
    const pool = new Pool({
      host,
      port,
      user,
      password,
      database: 'postgres',
    });

    // Check if database exists
    const existsResult = await pool.query(
      `
      SELECT 1 FROM pg_database WHERE datname = $1
    `,
      [dbName]
    );

    if (existsResult.rows.length > 0) {
      console.log(`ℹ️  Database '${dbName}' already exists`);

      // Use readline for reliable prompt after password input
      const rl2 = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const forceAnswer = await new Promise<string>((resolve) => {
        rl2.question('Run migrations anyway? (y/N): ', (answer) => {
          resolve(answer.trim().toLowerCase());
        });
      });

      rl2.close();

      const forceMigrations = forceAnswer === 'y' || forceAnswer === 'yes';
      pool.end();
      // If user wants to run migrations on existing DB, treat as "isNew" (needs migrations)
      return { success: true, isNew: forceMigrations };
    }

    // Try to create database
    await pool.query(`CREATE DATABASE "${dbName}"`);
    console.log(`✓ Created database '${dbName}'`);
    pool.end();
    return { success: true, isNew: true };
  } catch (error: unknown) {
    const isPermissionError =
      typeof error === 'object' &&
      error !== null &&
      (('code' in error && (error as { code: string }).code === '42501') ||
        ('message' in error && typeof error.message === 'string' && error.message.includes('permission denied')));

    if (isPermissionError) {
      console.log(`⚠️  Could not create database '${dbName}' automatically (insufficient privileges)`);
      console.log(`   Please create the database manually:`);
      console.log(`   psql -h ${host} -p ${port} -U ${user} -c "CREATE DATABASE \\"${dbName}\\""`);
      console.log('');

      await prompt('Press Enter when database is created...');

      // Verify it exists now
      try {
        const verifyPool = new Pool({
          host,
          port,
          user,
          password,
          database: dbName,
        });
        await verifyPool.query('SELECT 1');
        verifyPool.end();

        // Use readline for reliable prompt after password input
        const rl2 = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        const forceAnswer = await new Promise<string>((resolve) => {
          rl2.question('Run migrations anyway? (y/N): ', (answer) => {
            resolve(answer.trim().toLowerCase());
          });
        });

        rl2.close();

        const forceMigrations = forceAnswer === 'y' || forceAnswer === 'yes';
        // If user wants to run migrations on existing DB, treat as "isNew" (needs migrations)
        return { success: true, isNew: forceMigrations };
      } catch (_verifyError) {
        console.error(`❌ Could not connect to database '${dbName}' after manual creation`);
        return { success: false, isNew: false };
      }
    }
    throw error;
  }
}

async function runSchemaMigrations(dbUrl: string): Promise<void> {
  console.log('\n📦 Running schema migrations...');

  const migrationPath = path.resolve(__dirname, 'migrations/streamer-schema.sql');
  const sql = await fs.promises.readFile(migrationPath, 'utf-8');

  const pool = new Pool({ connectionString: dbUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    console.log('✓ Migrations completed successfully');
  } finally {
    client.release();
    await pool.end();
  }
}

// Main script
async function main(): Promise<void> {
  let tenantId: string | null = null;

  try {
    await initMetaClient();
    console.log('╔════════════════════════════════════════════╗');
    console.log('║     CREATE TENANT - Interactive Wizard     ║');
    console.log('╚════════════════════════════════════════════╝');
    console.log('');

    // Phase 1: Basic Information
    console.log('='.repeat(50));
    console.log('BASIC INFORMATION');
    console.log('='.repeat(50));

    const channelName = await prompt('Channel Name (tenant ID, lowercase alphanumeric + underscore, max 25 chars): ');

    // Validate format
    if (!/^[a-z0-9_]+$/.test(channelName)) {
      console.error('❌ Invalid format. Channel name must be lowercase with only letters, numbers, and underscores.');
      process.exit(1);
    }

    // Validate length
    if (channelName.length > 25) {
      console.error('❌ Channel name exceeds maximum length of 25 characters.');
      process.exit(1);
    }

    // Check for duplicates
    const existingTenant = await getTenantById(channelName);
    if (existingTenant) {
      console.error('❌ Tenant with this channel name already exists.');
      process.exit(1);
    }

    const displayName = (await prompt('Display Name (or press Enter to use channel name): ')) || channelName;

    console.log('\n='.repeat(50));
    console.log('POSTGRESQL SERVER');
    console.log('='.repeat(50));

    const dbHost = (await prompt('PostgreSQL host: ')) || 'localhost';
    const dbPort = parseInt((await prompt('PostgreSQL port: ')) || '5432') || 5432;
    const dbUser = await prompt('PostgreSQL username: ');
    const dbPassword = await promptHidden('PostgreSQL password: ');
    const dbName = channelName; // Use streamer ID as database name

    // Validate connection BEFORE continuing
    console.log('\n🔍 Validating PostgreSQL connection...');
    if (!validatePostgresConnection(dbHost, dbPort, dbUser, dbPassword)) {
      console.error('❌ Cannot proceed without valid PostgreSQL connection');
      process.exit(1);
    }
    console.log('✓ Connection validated');

    // Phase 2: Database Setup
    console.log('\n='.repeat(50));
    console.log('DATABASE SETUP');
    console.log('='.repeat(50));

    const dbResult = await createDatabase(dbHost, dbPort, dbUser, dbPassword, dbName);
    if (!dbResult.success) {
      console.error('❌ Could not set up database. Aborting.');
      process.exit(1);
    }

    const dbUrl = `postgresql://${dbUser}:${dbPassword}@${dbHost}:${dbPort}/${dbName}`;

    // Only run migrations for new databases or if explicitly requested
    if (dbResult.isNew) {
      await runSchemaMigrations(dbUrl);
      process.stdin.resume();
    } else {
      console.log(`ℹ️  Skipping migrations - database '${dbName}' already exists`);
    }

    // Phase 3: Streaming Platforms
    console.log('\n='.repeat(50));
    console.log('STREAMING PLATFORMS');
    console.log('='.repeat(50));

    const enableTwitch = await confirm('Enable Twitch?');
    let twitchData: any = null;

    if (enableTwitch) {
      console.log('\nTwitch Stream Info:');
      const twitchId = String(await prompt('User ID (string): '));
      const twitchUsername = await prompt('Username: ');
      const isMainPlatform = await confirm('Is this the main platform?');

      console.log('\nNote: OAuth credentials are NOT collected here.');
      console.log('      Run "npm run auth:twitch" after tenant creation to configure authentication.\n');

      twitchData = {
        enabled: true,
        id: twitchId,
        username: twitchUsername,
        mainPlatform: isMainPlatform,
      };
    }

    const enableKick = await confirm('\nEnable Kick?');
    let kickData: any = null;

    if (enableKick) {
      console.log('\nKick Stream Info:');
      const kickId = String(await prompt('User ID (string): '));
      const kickUsername = await prompt('Username: ');
      const isMainPlatform = await confirm('Is this the main platform?');

      kickData = {
        enabled: true,
        id: kickId || null,
        username: kickUsername,
        mainPlatform: isMainPlatform,
      };
    }

    if (!twitchData && !kickData) {
      console.error('❌ At least one streaming platform must be enabled');
      process.exit(1);
    }

    const twitchIsMain = twitchData?.mainPlatform === true;
    const kickIsMain = kickData?.mainPlatform === true;
    if (twitchIsMain && kickIsMain) {
      console.error('❌ Only one platform can be marked as main. Please restart the script.');
      process.exit(1);
    }

    // Phase 4: YouTube Upload Settings
    console.log('\n='.repeat(50));
    console.log('YOUTUBE UPLOAD SETTINGS');
    console.log('='.repeat(50));

    // YouTube uploads are always enabled - no prompt needed
    let youtubeData: any = null;

    console.log('\nUpload Behavior:');
    const youtubeDescription = await prompt('Video description template (use {channel} for name): ');
    const youtubePublic = await confirm('Videos public by default?');
    const youtubeVodUpload = await confirm('Enable VOD uploads?');
    const youtubePerGame = await confirm('Per-game upload?');

    let youtubeRestrictedGames: (string | null)[] = [];
    if (youtubePerGame) {
      const excluded = await prompt('Games to EXCLUDE from upload (comma-separated, or "none"): ');
      if (excluded.toLowerCase() !== 'none') {
        youtubeRestrictedGames = excluded.split(',').map((g) => g.trim() || null);
      }
    }

    const splitDurationStr = await prompt('Max VOD split duration (seconds, min: 10800/3hrs, max: 43199/12hrs): ');
    let youtubeSplitDuration = parseInt(splitDurationStr) || 10800;

    // Validate YouTube's limits: minimum 3 hours (10800s), maximum ~12 hours (43199s)
    if (youtubeSplitDuration < 10800) {
      console.log('⚠️  Minimum split duration is 3 hours (10800 seconds). Setting to minimum.');
      youtubeSplitDuration = 10800;
    } else if (youtubeSplitDuration > 43199) {
      console.log('⚠️  Maximum split duration is ~12 hours (43199 seconds). Setting to maximum.');
      youtubeSplitDuration = 43199;
    }

    const youtubeLiveUpload = await confirm(
      'Enable live upload while user is live (Will upload parts while stream is live)?'
    );
    const youtubeMultiTrack = await confirm('Multi-track audio upload?');
    // YouTube uploads always enabled by default
    const youtubeUploadEnabled = true;

    console.log('\nNote: OAuth credentials are NOT collected here.');
    console.log('      Run "npm run auth:youtube" after tenant creation to configure authentication.\n');

    youtubeData = {
      description: youtubeDescription,
      public: youtubePublic,
      vodUpload: youtubeVodUpload,
      perGameUpload: youtubePerGame,
      restrictedGames: youtubeRestrictedGames,
      splitDuration: youtubeSplitDuration,
      liveUpload: youtubeLiveUpload,
      multiTrack: youtubeMultiTrack,
      upload: youtubeUploadEnabled,
    };

    // Phase 5: Archive Settings
    console.log('\n='.repeat(50));
    console.log('ARCHIVE SETTINGS');
    console.log('='.repeat(50));

    const domainName = await prompt('Domain name (e.g., moon2.tv): ');
    const timezone = (await prompt('Timezone (e.g., America/Chicago): ')) || 'UTC';

    const chatDownload = await confirm('Download chat logs?');
    const vodDownload = await confirm('Download VODs?');
    const saveHLS = await confirm('Save HLS to disk?');
    const saveMP4 = await confirm('Save MP4 to disk?');

    // Phase 6: Summary & Confirmation
    console.log('\n' + '='.repeat(50));
    console.log('TENANT CREATION SUMMARY');
    console.log('='.repeat(50));

    console.log(`\nStreamer ID: ${channelName}`);
    console.log(`Display Name: ${displayName}`);
    console.log(`Database: postgresql://${dbUser}:***@${dbHost}:${dbPort}/${dbName}`);

    console.log('\nStreaming Platforms:');
    if (twitchData) {
      const mainBadge = twitchData.mainPlatform ? ' [MAIN]' : '';
      console.log(`  ✓ Twitch (${twitchData.id} / ${twitchData.username})${mainBadge}`);
    } else {
      console.log(`  ✗ Twitch disabled`);
    }
    if (kickData) {
      const mainBadge = kickData.mainPlatform ? ' [MAIN]' : '';
      console.log(`  ✓ Kick (${kickData.id || 'N/A'} / ${kickData.username})${mainBadge}`);
    } else {
      console.log(`  ✗ Kick disabled`);
    }

    if (youtubeData) {
      console.log('\nYouTube Uploads:');
      console.log(`  ✓ Enabled`);
      console.log(`    - VOD upload: ${youtubeData.vodUpload ? 'yes' : 'no'}`);
      console.log(`    - Per-game upload: ${youtubeData.perGameUpload ? 'yes' : 'no'}`);
      if (youtubeData.restrictedGames && youtubeData.restrictedGames.length > 0) {
        console.log(`    - Excluded games: ${youtubeData.restrictedGames.join(', ')}`);
      }
      console.log(`    - Multi-track: ${youtubeData.multiTrack ? 'yes' : 'no'}`);
      console.log(`    - Split duration: ${youtubeData.splitDuration}s`);
    } else {
      console.log('\nYouTube Uploads: ✗ Disabled');
    }

    console.log('\nSettings:');
    console.log(`  Domain: ${domainName}`);
    console.log(`  Timezone: ${timezone}`);
    console.log(`  Chat Download: ${chatDownload ? 'yes' : 'no'}`);
    console.log(`  VOD Download: ${vodDownload ? 'yes' : 'no'}`);
    console.log(`  Save HLS: ${saveHLS ? 'yes' : 'no'}`);
    console.log(`  Save MP4: ${saveMP4 ? 'yes' : 'no'}`);

    // Phase 7: Execution - Register tenant in meta database

    const tenantData: any = {
      id: channelName,
      display_name: displayName,
      database_name: dbName,
      settings: {
        domainName,
        timezone,
        chatDownload,
        vodDownload,
        saveHLS,
        saveMP4,
      },
    };

    if (twitchData) {
      tenantData.twitch = {
        enabled: true,
        id: twitchData.id,
        username: twitchData.username,
        mainPlatform: twitchData.mainPlatform,
      };
    }

    if (kickData) {
      tenantData.kick = {
        enabled: true,
        id: kickData.id || null,
        username: kickData.username,
        mainPlatform: kickData.mainPlatform,
      };
    }

    if (youtubeData) {
      tenantData.youtube = {
        description: youtubeData.description,
        public: youtubeData.public,
        vodUpload: youtubeData.vodUpload,
        perGameUpload: youtubeData.perGameUpload,
        restrictedGames: youtubeData.restrictedGames,
        splitDuration: youtubeData.splitDuration,
        liveUpload: youtubeData.liveUpload,
        multiTrack: youtubeData.multiTrack,
        upload: youtubeData.upload,
      };
    }

    // Step 2: Insert into meta DB with explicit ID
    const createdTenant = await createTenant(tenantData as InsertableTenants);
    tenantId = createdTenant.id;

    // Success message
    console.log('✅ TENANT CREATED SUCCESSFULLY!');
    console.log(`\nStreamer ID: ${channelName}`);
    console.log(`Tenant ID in meta DB: ${createdTenant.id}`);
    console.log(`\n🗄️  Database: postgresql://${dbUser}:***@${dbHost}:${dbPort}/${dbName}`);
    console.log('   Schema: Migrated with normalized tables');

    // Optional Authentication Setup section
    if (twitchData || youtubeData) {
      console.log('\nOptional Authentication Setup:');
      console.log('-'.repeat(35));
      if (twitchData) {
        console.log(`  • Twitch Auth: npm run auth:twitch (then enter tenant ID "${channelName}")`);
      }
      if (youtubeData) {
        console.log(`  • YouTube Auth: npm run auth:youtube (then enter tenant ID "${channelName}")`);
      }
      console.log('\nThese scripts will guide you through the OAuth flow and securely store credentials.');
    }
  } catch (_error: unknown) {
    console.error('\n❌ Error during tenant creation:');

    // Rollback if tenant was created
    if (tenantId !== null) {
      const rollback = await confirm('\nTenant was partially created. Rollback from meta DB?');
      if (rollback) {
        try {
          await deleteTenant(tenantId);
          console.log('✓ Rolled back tenant from meta DB');
        } catch (rollbackError) {
          const errorMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          console.error('⚠️  Could not rollback:', errorMessage);
        }
      }
    }

    process.exit(1);
  } finally {
    await closeMetaClient();
  }
}

main();
