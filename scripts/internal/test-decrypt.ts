#!/usr/bin/env node

/**
 * Debug script: Display decrypted tenant credentials from database
 *
 * WARNING: This displays sensitive secrets (tokens, API keys) in plaintext!
 * Only use for debugging purposes. Never commit or share output containing these values.
 */

import 'dotenv/config';
import { program } from 'commander';
import { initMetaClient, getMetaClient } from '../../src/db/meta-client.js';
import { decryptScalar, decryptObject } from '../../src/utils/encryption.js';

interface DecryptionResult {
  raw: string | null;
  decrypted?: any;
}

async function decryptField(value: string | null): Promise<DecryptionResult> {
  if (!value) return { raw: value };

  const result: DecryptionResult = { raw: value };

  try {
    // Try to parse as JSON first (some fields might be stored unencrypted for debugging)
    let parsedValue;
    try {
      parsedValue = JSON.parse(value);
    } catch {
      // Not valid JSON, will need decryption
    }

    if (!parsedValue && process.env.ENCRYPTION_MASTER_KEY) {
      // Try decryptScalar first (for fields like apiKey that are simple strings)
      try {
        result.decrypted = decryptScalar(value);
      } catch (scalarError: any) {
        // If scalar fails, try decryptObject for complex objects
        try {
          result.decrypted = decryptObject(value);
        } catch (e: any) {
          console.error(`⚠️  Failed to decrypt field: ${e.message}`);
        }
      }
    } else if (!parsedValue && !process.env.ENCRYPTION_MASTER_KEY) {
      // Check if it looks like encrypted data (base64-like string with no JSON structure)
      const isLikelyEncrypted = /^[A-Za-z0-9+/=]{50,}$/.test(value);

      console.warn('⚠️  ENCRYPTION_MASTER_KEY not set. Cannot decrypt values.');
      result.decrypted = { error: 'ENCRYPTION_MASTER_KEY required', rawValue: isLikelyEncrypted ? '[encrypted data]' : value.substring(0, 100) + (value.length > 100 ? '...' : '') };
    } else if (parsedValue) {
      // Already parsed as JSON (unencrypted or failed decryption attempt returned string)
      result.decrypted =
        typeof parsedValue === 'string' && /^[A-Za-z0-9+/=]{50,}$/.test(parsedValue)
          ? { error: 'Could not parse - may be encrypted', rawValue: value.substring(0, 100) + (value.length > 100 ? '...' : '') }
          : parsedValue;
    }
  } catch (error: unknown) {
    const err = error as Error;
    result.decrypted = { error: `Decryption failed: ${err.message}` };
  }

  return result;
}

function displayField(name: string, value: DecryptionResult): void {
  console.log(`\n${name}:`);
  console.log('─'.repeat(50));

  if (value.raw) {
    const preview = typeof value.raw === 'string' && value.raw.length > 120 ? `${value.raw.substring(0, 120)}...` : String(value.raw);

    console.log(`Raw: ${preview}`);
  } else {
    console.log('Raw: (null)');
  }

  if ((value.decrypted && typeof value.decrypted !== 'object') || (!('error' in value.decrypted) as any)) {
    // Handle both string and object decrypted values
    console.log('\nDecrypted:');

    if (typeof value.decrypted === 'string') {
      const preview = value.decrypted.length > 120 ? `${value.decrypted.substring(0, 120)}...` : value.decrypted;
      console.log(`  ${preview}`);
    } else {
      // It's an object - format nicely with JSON.stringify
      const decryptedStr = JSON.stringify(value.decrypted as any, null, 2);

      // Color the output to indicate it's sensitive data
      const lines = decryptedStr.split('\n').map((line) => `  ${line}`);
      console.log(lines.join('\n'));
    }
  } else if (value.decrypted && typeof value.decrypted === 'object' && 'error' in value.decrypted) {
    console.log(`\n⚠️  Decryption: ${(value.decrypted as any).error}`);

    if ((value.decrypted as any).rawValue) {
      console.log(`   Preview: ${(value.decrypted as any)?.rawValue || 'N/A'}`);
    }
  } else {
    console.log('\nDecrypted: (no data available for decryption)');
  }

  console.log('─'.repeat(50));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (!process.env.ENCRYPTION_MASTER_KEY && !args.includes('--show-raw-only')) {
    console.warn('\n⚠️  WARNING: ENCRYPTION_MASTER_KEY not set in environment!');
    console.log('   Set it before running to decrypt values.\n');
  }

  program
    .name('debug-decrypt')
    .description('Display decrypted tenant credentials from database (DEBUGGING ONLY)')
    .version('1.0.0')
    .argument('<streamer_id>', 'Streamer ID or display name to inspect')
    .option('--twitch-only', 'Only show Twitch-related fields')
    .option('--youtube-only', 'Only show YouTube-related fields')
    .option('--kick-only', 'Only show Kick-related fields')
    .option('--show-raw-only', 'Show raw encrypted values without attempting decryption');

  program.parse(process.argv);

  const options = program.opts();

  if (!program.args[0]) {
    console.error('Error: Streamer ID is required\n');
    program.help();
    process.exit(1);
  }

  // Determine which fields to show based on flags
  let showTwitchOnly = false;
  let showYoutubeOnly = false;
  let showKickOnly = false;

  if (options.twitchOnly) {
    console.log('\n🔍 Showing Twitch credentials only\n');
    showTwitchOnly = true;
  } else if (options.youtubeOnly) {
    console.log('\n🔍 Showing YouTube credentials only\n');
    showYoutubeOnly = true;
  } else if (options.kickOnly) {
    console.log('\n🔍 Showing Kick configuration only\n');
    showKickOnly = true;
  }

  try {
    await initMetaClient();
    // Find tenant by ID or display name
    let tenant: any | null = await getMetaClient().tenant.findUnique({
      where: { id: program.args[0] },
    });

    if (!tenant) {
      const allTenants = await getMetaClient().tenant.findMany();
      tenant = allTenants.find((t: any) => t.displayName === program.args[0]);

      if (tenant) {
        console.log(`\nℹ️  Found by display name instead of ID`);
      }
    }

    if (!tenant) {
      console.error(`Error: Tenant "${program.args[0]}" not found in database.`);
      process.exit(1);
    }

    // Display header with warning
    console.log('\n' + '='.repeat(70));
    console.warn('⚠️  DANGEROUS: This displays decrypted secrets! ⚠️');
    console.log('='.repeat(70));
    console.log(`\nTenant ID: ${tenant.id}`);
    console.log(`Display Name: ${(tenant as any).displayName || 'N/A'}`);

    if (showTwitchOnly) {
      // Show Twitch fields only
      const twitch = (tenant as any)?.twitch;

      if (!twitch) {
        console.log('\nNo Twitch configuration found for this tenant.');
      } else {
        displayField('Twitch ID', { raw: String(twitch.id || null), decrypted: twitch.id });
        displayField('Twitch Username', { raw: String(twitch.username || null), decrypted: twitch.username });

        if (twitch.auth) {
          const authResult = await decryptField(String(twitch.auth));

          // Show enabled status first without decryption attempt
          console.log(`\nEnabled: ${twitch.enabled ? 'yes' : 'no'}\n`);

          displayField('Twitch Auth Credentials', authResult);
        } else {
          console.log('\nNo Twitch credentials configured.');
        }
      }
    } else if (showYoutubeOnly) {
      // Show YouTube fields only
      const youtube = (tenant as any)?.youtube;

      if (!youtube) {
        console.log('\nNo YouTube configuration found for this tenant.');
      } else {
        const apiKeyResult = await decryptField(String(youtube.apiKey || null));
        displayField('YouTube API Key', apiKeyResult);

        // Show non-encrypted settings first
        const youtubeSettings = ['description', 'public', 'vodUpload', 'perGameUpload', 'splitDuration', 'liveUpload', 'multiTrack', 'upload'];

        console.log('\nYouTube Settings:');
        console.log('─'.repeat(50));
        for (const setting of youtubeSettings) {
          const value = youtube[setting];
          if (value !== undefined && value !== null) {
            console.log(`  ${setting}:`, typeof value === 'boolean' ? String(value).toUpperCase() : value);
          }
        }

        // Show restricted games array if present
        if (youtube.restrictedGames && youtube.restrictedGames.length > 0) {
          console.log('\nRestricted Games:');
          youtube.restrictedGames.forEach((game: string | null, index: number) => {
            if (game === null) {
              console.log(`  [${index}]: *ALL GAMES*`);
            } else {
              console.log(`  [${index}]: ${game}`);
            }
          });
        }

        // Show auth tokens last as they're most sensitive
        if (youtube.auth) {
          const authResult = await decryptField(String(youtube.auth));

          displayField('YouTube OAuth Tokens', authResult);
        } else {
          console.log('\nNo YouTube OAuth credentials configured.');
        }
      }
    } else if (showKickOnly) {
      // Show Kick fields only
      const kick = (tenant as any)?.kick;

      if (!kick) {
        console.log('\nNo Kick configuration found for this tenant.');
      } else {
        displayField('Kick ID', { raw: String(kick.id || null), decrypted: kick.id });
        displayField('Kick Username', { raw: String(kick.username || null), decrypted: kick.username });

        console.log(`\nEnabled: ${kick.enabled ? 'yes' : 'no'}\n`);
      }
    } else {
      // Show ALL encrypted fields (default behavior)

      if ((tenant as any).twitch?.auth) {
        const twitchAuthResult = await decryptField(String((tenant as any).twitch.auth));

        console.log('\nTwitch Configuration:');
        displayField('Auth Credentials', twitchAuthResult);
      }

      if ((tenant as any).youtube?.apiKey) {
        const youtubeApiKeyResult = await decryptField(String((tenant as any).youtube.apiKey));

        console.log('\nYouTube API Key:');
        displayField('API Key', youtubeApiKeyResult);
      }

      if ((tenant as any).youtube?.auth) {
        const youtubeAuthResult = await decryptField(String((tenant as any).youtube.auth));

        console.log('\nYouTube OAuth Tokens:');
        displayField('Auth Credentials', youtubeAuthResult);
      }
    }
  } catch (error: unknown) {
    const err = error as Error;
    console.error('\n❌ Error:', err.message || String(error));

    if (process.env.NODE_ENV !== 'production') {
      console.log(err.stack);
    }

    process.exit(1);
  } finally {
    await getMetaClient().$disconnect();
  }
}

main().catch((error: unknown) => {
  const err = error as Error;
  console.error('Fatal error:', err.message || String(error));
  process.exit(1);
});
