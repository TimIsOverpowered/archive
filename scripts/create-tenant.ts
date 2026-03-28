#!/usr/bin/env node

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';
import { metaClient } from '../src/db/meta-client';
import { encryptObject, encryptScalar, validateEncryptionKey } from '../src/utils/encryption';

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
function validatePostgresConnection(host: string, port: number, user: string, password: string): boolean {
  try {
    const pool = new Pool({
      host,
      port,
      user,
      password,
      database: 'postgres', // Connect to default postgres DB
    });

    const result = pool.query('SELECT 1');
    pool.end();
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`❌ Cannot connect to PostgreSQL server at ${host}:${port}`);
    console.error(`   Error: ${errorMessage}`);
    return false;
  }
}

// Interactive prompts
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rlHidden = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Disable terminal echo for hidden input
    process.stdin.setRawMode(true);
    process.stdin.resume();

    console.log(question);

    const buffer: string[] = [];
    let hasInput = false;

    const listener = (chunk: Buffer) => {
      for (const char of chunk.toString()) {
        if (char === '\r' || char === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.removeListener('data', listener);
          rlHidden.close();
          resolve(buffer.join(''));
          hasInput = true;
          return;
        }
        if (char === '\u007F' || char === '\b') {
          // Backspace
          if (buffer.length > 0) {
            buffer.pop();
            process.stdout.write('\b \b');
          }
        } else if (char >= '\x20' && char <= '\x7E') {
          // Printable ASCII
          buffer.push(char);
          process.stdout.write('*');
        }
      }
    };

    process.stdin.on('data', listener);
  });
}

function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    rl.question(`${question} (y/N): `, (answer) => {
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

// Database operations
async function createDatabase(host: string, port: number, user: string, password: string, dbName: string): Promise<boolean> {
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
      pool.end();
      return true;
    }

    // Try to create database
    await pool.query(`CREATE DATABASE "${dbName}"`);
    console.log(`✓ Created database '${dbName}'`);
    pool.end();
    return true;
  } catch (error: any) {
    if (error.code === '42501' || error.message.includes('permission denied')) {
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
        return true;
      } catch (verifyError) {
        console.error(`❌ Could not connect to database '${dbName}' after manual creation`);
        return false;
      }
    }
    throw error;
  }
}

async function runMigrations(channelName: string, dbUrl: string): Promise<void> {
  console.log('\n📦 Running Prisma migrations...');

  const envDbUrl = process.env.DATABASE_URL;

  try {
    process.env.DATABASE_URL = dbUrl;

    // Run migrations
    execSync('npx prisma migrate deploy --schema=./prisma/schema.prisma', { stdio: 'inherit' });

    console.log('✓ Migrations completed successfully');
  } catch (error) {
    console.error('❌ Migration failed');
    throw error;
  } finally {
    process.env.DATABASE_URL = envDbUrl;
  }
}

// Main script
async function main(): Promise<void> {
  let tenantId: string | null = null;

  try {
    console.log('╔════════════════════════════════════════════╗');
    console.log('║     CREATE TENANT - Interactive Wizard     ║');
    console.log('╚════════════════════════════════════════════╝');
    console.log('');

    // Phase 1: Basic Information
    console.log('─'.repeat(50));
    console.log('BASIC INFORMATION');
    console.log('─'.repeat(50));

    let channelName = await prompt('Channel Name (tenant ID, lowercase alphanumeric + underscore, max 25 chars): ');

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
    const existingTenant = await metaClient.tenant.findFirst({
      where: { id: channelName },
    });
    if (existingTenant) {
      console.error('❌ Tenant with this channel name already exists.');
      process.exit(1);
    }

    const displayName = (await prompt('Display Name (or press Enter to use channel name): ')) || channelName;

    console.log('\n─'.repeat(50));
    console.log('POSTGRESQL SERVER');
    console.log('─'.repeat(50));

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
    console.log('\n─'.repeat(50));
    console.log('DATABASE SETUP');
    console.log('─'.repeat(50));

    const dbCreated = await createDatabase(dbHost, dbPort, dbUser, dbPassword, dbName);
    if (!dbCreated) {
      console.error('❌ Could not set up database. Aborting.');
      process.exit(1);
    }

    const dbUrl = ` postgresql://<user>:***@<host>:5432/<db>

    await runMigrations(channelName, dbUrl);

    // Phase 3: Streaming Platforms
    console.log('\n─'.repeat(50));
    console.log('STREAMING PLATFORMS');
    console.log('─'.repeat(50));

    const enableTwitch = await confirm('Enable Twitch?');
    let twitchData: any = null;

    if (enableTwitch) {
      console.log('\nTwitch Stream Info:');
      const twitchId = await prompt('User ID (numeric): ');
      const twitchUsername = await prompt('Username: ');

      console.log('\nTwitch OAuth App Credentials:');
      const twitchClientId = await prompt('Client ID: ');
      const twitchClientSecret = await promptHidden('Client Secret: ');
      const twitchAccessToken = await promptHidden('Access Token: ');

      twitchData = {
        enabled: true,
        id: twitchId,
        username: twitchUsername,
        clientId: twitchClientId,
        clientSecret: twitchClientSecret,
        accessToken: twitchAccessToken,
      };
    }

    const enableKick = await confirm('\nEnable Kick?');
    let kickData: any = null;

    if (enableKick) {
      console.log('\nKick Stream Info:');
      const kickId = await prompt('User ID (numeric, optional): ');
      const kickUsername = await prompt('Username: ');

      kickData = {
        enabled: true,
        id: kickId || null,
        username: kickUsername,
      };
    }

    if (!twitchData && !kickData) {
      console.error('❌ At least one streaming platform must be enabled');
      process.exit(1);
    }

    // Phase 4: YouTube Upload Settings
    console.log('\n─'.repeat(50));
    console.log('YOUTUBE UPLOAD SETTINGS');
    console.log('─'.repeat(50));

    const enableYouTube = await confirm('Enable YouTube uploads?');
    let youtubeData: any = null;
    let googleData: any = null;

    if (enableYouTube) {
      console.log('\nYouTube API:');
      const youtubeApiKey = await promptHidden('YouTube Data API Key: ');

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

      const splitDurationStr = (await prompt('Max VOD split duration (seconds): ')) || '10800';
      const youtubeSplitDuration = parseInt(splitDurationStr) || 10800;

      const youtubeLiveUpload = await confirm('Enable live stream upload?');
      const youtubeMultiTrack = await confirm('Multi-track audio upload?');
      const youtubeUploadEnabled = await confirm('Enable uploads overall?');

      console.log('\nYouTube OAuth Credentials:');
      const youtubeAccessToken = await promptHidden('Access Token: ');
      const youtubeRefreshToken = await promptHidden('Refresh Token: ');

      youtubeData = {
        apiKey: youtubeApiKey,
        description: youtubeDescription,
        public: youtubePublic,
        vodUpload: youtubeVodUpload,
        perGameUpload: youtubePerGame,
        restrictedGames: youtubeRestrictedGames,
        splitDuration: youtubeSplitDuration,
        liveUpload: youtubeLiveUpload,
        multiTrack: youtubeMultiTrack,
        upload: youtubeUploadEnabled,
        accessToken: youtubeAccessToken,
        refreshToken: youtubeRefreshToken,
      };

      // Google OAuth for YouTube token refresh
      console.log('\n─'.repeat(50));
      console.log('GOOGLE OAUTH (for YouTube token refresh)');
      console.log('─'.repeat(50));
      console.log('These are PUBLIC credentials for OAuth flow, not secrets\n');

      const googleClientId = await prompt('Google OAuth Client ID: ');
      const googleClientSecret = await prompt('Google OAuth Client Secret: ');
      const googleRedirectUrl = await prompt('Redirect URL (or press Enter to leave empty): ');

      googleData = {
        client_id: googleClientId,
        client_secret: googleClientSecret,
        redirect_url: googleRedirectUrl,
      };
    }

    // Phase 5: Archive Settings
    console.log('\n─'.repeat(50));
    console.log('ARCHIVE SETTINGS');
    console.log('─'.repeat(50));

    const domainName = await prompt('Domain name (e.g., moon2.tv): ');
    const vodPath = (await prompt('VOD storage path: ')) || '/mnt/storage/vods';
    const livePath = (await prompt('Live stream path: ')) || '/mnt/live';
    const timezone = (await prompt('Timezone (e.g., America/Chicago): ')) || 'America/Chicago';

    const chatDownload = await confirm('Download chat logs?');
    const vodDownload = await confirm('Download VODs?');
    const saveHLS = await confirm('Save as HLS (.ts segments)?');
    const saveMP4 = await confirm('Save as MP4?');

    // Phase 6: Summary & Confirmation
    console.log('\n' + '='.repeat(50));
    console.log('TENANT CREATION SUMMARY');
    console.log('='.repeat(50));

    console.log(`\nStreamer ID: ${channelName}`);
    console.log(`Display Name: ${displayName}`);
    console.log(`Database:  postgresql://<user>:***@<host>:5432/<db>

    console.log('\nStreaming Platforms:');
    if (twitchData) {
      console.log(`  ✓ Twitch (${twitchData.id} / ${twitchData.username})`);
    } else {
      console.log(`  ✗ Twitch disabled`);
    }
    if (kickData) {
      console.log(`  ✓ Kick (${kickData.id || 'N/A'} / ${kickData.username})`);
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
    console.log(`  VOD Path: ${vodPath}`);
    console.log(`  Live Path: ${livePath}`);
    console.log(`  Timezone: ${timezone}`);
    console.log(`  Chat Download: ${chatDownload ? 'yes' : 'no'}`);
    console.log(`  VOD Download: ${vodDownload ? 'yes' : 'no'}`);
    console.log(`  Save HLS: ${saveHLS ? 'yes' : 'no'}`);
    console.log(`  Save MP4: ${saveMP4 ? 'yes' : 'no'}`);

    console.log('\n' + '='.repeat(50));
    console.log('ACTIONS TO BE TAKEN:');
    console.log('='.repeat(50));
    console.log('1. ✓ Database created/verified');
    console.log('2. ✓ Prisma migrations applied');
    console.log('3. Generate config files:');
    console.log(`   - config/config.json.${channelName}`);
    console.log(`   - config/default.json.${channelName}`);
    console.log('4. Register tenant in meta database (with encryption)');

    const proceed = await confirm('\nProceed with tenant creation?');
    if (!proceed) {
      console.log('❌ Tenant creation cancelled');
      process.exit(0);
    }

    // Phase 7: Execution

    // Step 1: Generate config/config.json.<channelName>
    const configData: any = {
      channel: displayName,
      domainName: domainName,
      vodPath: vodPath,
      livePath: livePath,
      timezone: timezone,
      chatDownload: chatDownload,
      vodDownload: vodDownload,
      saveHLS: saveHLS,
      saveMP4: saveMP4,
    };

    if (twitchData) {
      configData.twitch = {
        enabled: true,
        auth: {
          client_id: twitchData.clientId,
          client_secret: twitchData.clientSecret,
          access_token: twitchData.accessToken,
        },
        id: twitchData.id,
        username: twitchData.username,
      };
    } else {
      configData.twitch = { enabled: false };
    }

    if (kickData) {
      configData.kick = {
        enabled: true,
        id: kickData.id || '',
        username: kickData.username,
      };
    } else {
      configData.kick = { enabled: false };
    }

    if (googleData) {
      configData.google = googleData;
    }

    if (youtubeData) {
      configData.youtube = {
        description: youtubeData.description,
        public: youtubeData.public,
        vodUpload: youtubeData.vodUpload,
        perGameUpload: youtubeData.perGameUpload,
        restrictedGames: youtubeData.restrictedGames,
        splitDuration: youtubeData.splitDuration,
        api_key: youtubeData.api_key,
        liveUpload: youtubeData.liveUpload,
        multiTrack: youtubeData.multiTrack,
        upload: youtubeData.upload,
        auth: {
          access_token: youtubeData.accessToken,
          scope:
            'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl',
          token_type: 'Bearer',
          expires_in: 3599,
          refresh_token: youtubeData.refreshToken,
        },
      };
    }

    const configDir = path.join(__dirname, '..', 'config');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    fs.writeFileSync(path.join(configDir, `config.json.${channelName}`), JSON.stringify(configData, null, 2));
    console.log(`✓ Created config/config.json.${channelName}`);

    // Step 2: Generate config/default.json.<channelName>
    const defaultConfig = {
      host: 'localhost',
      port: 3030,
      public: './public/',
      paginate: { default: 10, max: 50 },
      postgres: dbUrl,
      ADMIN_API_KEY: 'YOUR_ADMIN_API_KEY',
      redis: {
        host: '127.0.0.1',
        port: 6379,
        useSocket: false,
        path: '/tmp/redis.sock',
      },
    };

    fs.writeFileSync(path.join(configDir, `default.json.${channelName}`), JSON.stringify(defaultConfig, null, 2));
    console.log(`✓ Created config/default.json.${channelName}`);

    // Step 3: Prepare meta DB record with encryption
    const tenantData: any = {
      display_name: displayName,
      database_url: encryptScalar(dbUrl),
      settings: {
        domain_name: domainName,
        vodPath: vodPath,
        livePath: livePath,
        timezone: timezone,
        chatDownload: chatDownload,
        vodDownload: vodDownload,
        saveHLS: saveHLS,
        saveMP4: saveMP4,
      },
    };

    if (twitchData) {
      tenantData.twitch = {
        enabled: true,
        id: twitchData.id,
        username: twitchData.username,
        auth: encryptObject({
          client_id: twitchData.clientId,
          client_secret: twitchData.clientSecret,
          access_token: twitchData.accessToken,
        }),
      };
    }

    if (kickData) {
      tenantData.kick = {
        enabled: true,
        id: kickData.id || null,
        username: kickData.username,
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
        api_key: encryptScalar(youtubeData.api_key),
        liveUpload: youtubeData.liveUpload,
        multiTrack: youtubeData.multiTrack,
        upload: youtubeData.upload,
        auth: encryptObject({
          access_token: youtubeData.accessToken,
          scope:
            'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl',
          token_type: 'Bearer',
          expires_in: 3599,
          refresh_token: youtubeData.refreshToken,
        }),
      };
    }

    if (googleData) {
      tenantData.google = googleData; // NOT encrypted - public OAuth credentials
    }

    // Step 4: Insert into meta DB with explicit ID
    const createdTenant = await metaClient.tenant.create({
      data: {
        id: channelName,
        ...tenantData,
      },
    });
    tenantId = createdTenant.id;

    // Step 5: Success message
    console.log('\n' + '✅'.repeat(20));
    console.log('TENANT CREATED SUCCESSFULLY!');
    console.log('✅'.repeat(20));
    console.log(`\nStreamer ID: ${channelName}`);
    console.log(`Tenant ID in meta DB: ${createdTenant.id}`);
    console.log(`\n📁 Config files created:`);
    console.log(`   - config/config.json.${channelName}`);
    console.log(`   - config/default.json.${channelName}`);
    console.log(`\n🗄️  Database:  postgresql://<user>:***@<host>:5432/<db>
    console.log(`   Schema: Migrated with normalized tables`);
    console.log('\n⚠️  IMPORTANT: Store these credentials securely:');
    console.log('   Plaintext credentials are stored in config/config.json.${channelName}');
    console.log('   - Twitch Client Secret, Access Token');
    if (youtubeData) {
      console.log('   - YouTube API Key, Refresh Token');
    }
    if (googleData) {
      console.log('   - Google OAuth Client Secret');
    }
  } catch (error: any) {
    console.error('\n❌ Error during tenant creation:');
    console.error(error.message || error);

    // Rollback if tenant was created
    if (tenantId !== null) {
      const rollback = await confirm('\nTenant was partially created. Rollback from meta DB?');
      if (rollback) {
        try {
          await metaClient.tenant.delete({ where: { id: tenantId } });
          console.log('✓ Rolled back tenant from meta DB');
        } catch (rollbackError) {
          const errorMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          console.error('⚠️  Could not rollback:', errorMessage);
        }
      }
    }

    process.exit(1);
  } finally {
    rl.close();
    await metaClient.$disconnect();
  }
}

main();
