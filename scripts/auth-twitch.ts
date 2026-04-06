#!/usr/bin/env node

import 'dotenv/config';
import * as readline from 'readline';
import { metaClient } from '../src/db/meta-client.js';
import { encryptObject, validateEncryptionKey } from '../src/utils/encryption.js';
import { extractErrorDetails } from '../src/utils/error.js';

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
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    console.log(question);

    const buffer: string[] = [];

    const listener = (chunk: Buffer) => {
      for (const char of chunk.toString()) {
        if (char === '\r' || char === '\n') {
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
          }
          process.stdin.removeListener('data', listener);
          rlHidden.close();

          console.log('\n'); // New line after hidden input
          resolve(buffer.join(''));
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

interface TwitchAuthResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

async function main(): Promise<void> {
  let tenantIdToUpdate: string | null = null;

  try {
    console.log('╔════════════════════════════╗');
    console.log('║  TWITCH AUTH CONFIGURATOR  ║');
    console.log('╚════════════════════════════╝');

    // Phase 1: Tenant Selection
    console.log('\n' + '─'.repeat(40));
    console.log('TENANT SELECTION');
    console.log('─'.repeat(40) + '\n');

    const tenantId = await prompt('Tenant/Streamer ID: ');

    if (!tenantId) {
      console.error('\n❌ Tenant ID is required.');
      process.exit(1);
    }

    // Look up tenant in meta DB
    const tenant = await metaClient.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant) {
      console.error('\n❌ Tenant not found:', tenantId);
      console.error('   Make sure the tenant ID is correct and exists in your database.');
      process.exit(1);
    }

    console.log(`\n✓ Tenant found!`);

    // Display current Twitch status
    const hasTwitchAuth = (tenant as any).twitch?.auth;
    const twitchEnabled = (tenant as any).twitch?.enabled || false;

    if (hasTwitchAuth) {
      console.log(`\nCurrent Twitch Status: Enabled with auth configured`);
    } else {
      console.log(`\nCurrent Twitch Status: Disabled (no credentials configured)`);
    }

    // Phase 2: Credentials Input
    console.log('\n' + '─'.repeat(40));
    console.log('CREDENTIALS INPUT');
    console.log('─'.repeat(40) + '\n');

    const clientId = await prompt('Client ID: ');

    if (!clientId) {
      console.error('\n❌ Client ID is required.');
      process.exit(1);
    }

    const clientSecret = await prompt('Client Secret: ');

    if (!clientSecret) {
      console.error('\n❌ Client Secret is required.');
      process.exit(1);
    }

    // Phase 3: Generate Access Token
    console.log('\n🔄 Generating access token via Twitch OAuth client credentials flow...');

    let oauthResult: TwitchAuthResponse;
    try {
      const response = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'client_credentials',
        }),
      });

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`Twitch API returned ${response.status}: ${errorData}`);
      }

      oauthResult = await response.json();
      console.log('✓ Access token generated successfully!');
    } catch (error) {
      const details = extractErrorDetails(error);
      console.error('\n❌ Failed to generate access token:');
      console.error(`   ${details.message}`);
      console.error('Check your credentials and try again.');
      process.exit(1);
    }

    // Phase 4: Build Auth Object & Encrypt
    const expiryDate = Date.now() + oauthResult.expires_in * 1000;

    const twitchAuthObject = {
      client_id: clientId,
      client_secret: clientSecret,
      access_token: oauthResult.access_token,
      expiry_date: expiryDate,
    };

    console.log('\nEncrypting credentials with AES-256-GCM...');

    const encryptedTwitchAuth = encryptObject(twitchAuthObject);

    // Phase 5: Update Meta DB (preserve existing config)
    console.log(`Storing in meta database for tenant "${tenantId}"...\n`);

    let updatedTwitchConfig: any;

    if ((tenant as any).twitch) {
      try {
        const currentTwitch = JSON.parse(JSON.stringify((tenant as any).twitch));

        // Preserve existing fields like username, id, etc. (if they exist unencrypted)
        updatedTwitchConfig = {
          enabled: true,
          username: currentTwitch.username || null,
          id: currentTwitch.id || null,
          auth: encryptedTwitchAuth,
        };
      } catch {
        // If parsing fails, start fresh with just the new auth
        updatedTwitchConfig = {
          enabled: true,
          username: null,
          id: null,
          auth: encryptedTwitchAuth,
        };
      }
    } else {
      updatedTwitchConfig = {
        enabled: true,
        username: null,
        id: null,
        auth: encryptedTwitchAuth,
      };
    }

    await metaClient.tenant.update({
      where: { id: tenantId },
      data: {
        twitch: updatedTwitchConfig,
      },
    });

    // Track the ID for potential rollback on error (though we're past that point)
    tenantIdToUpdate = tenantId;

    // Phase 6: Success Confirmation
    console.log('╔══════════════╗');
    console.log('║ ✓ SUCCESSFUL ║');
    console.log('╚══════════════╝\n');

    const clientIdPreview = clientId.length > 8 ? `${clientId.substring(0, 8)}...` : clientId;
    const tokenPrefix = oauthResult.access_token.substring(0, 25);

    console.log(`Tenant ID: ${tenantId}\n`);

    console.log('Auth Object Generated & Stored:');
    console.log(`  • Client ID: ${clientIdPreview}`);
    console.log(`  • Access Token: ${tokenPrefix}...\n`);

    console.log('Credentials encrypted with AES-256-GCM and stored in meta database.\n');

    const expiresInHours = Math.round(oauthResult.expires_in / 3600);
    const expiryDateStr = new Date(expiryDate).toISOString();
    console.log(`Note: Access token expires after ~${expiresInHours} hours (at ${expiryDateStr}) but can be refreshed`);
    console.log('      automatically using the stored client_id + client_secret.');
  } catch (error) {
    const details = extractErrorDetails(error);

    console.error('\n❌ Error during Twitch auth configuration:');
    console.error(details.message);

    // Rollback if tenant was partially updated
    if (tenantIdToUpdate !== null && process.argv.includes('--rollback')) {
      try {
        await metaClient.tenant.delete({ where: { id: tenantIdToUpdate } });
        console.log('✓ Rolled back changes from meta DB');
      } catch (rollbackError) {
        const rollbackDetails = extractErrorDetails(rollbackError);
        console.error('⚠️  Could not rollback:', rollbackDetails.message);
      }
    }

    process.exit(1);
  } finally {
    rl.close();
    await metaClient.$disconnect();
  }
}

main();
