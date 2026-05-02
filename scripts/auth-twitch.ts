import 'dotenv/config';
import * as readline from 'readline';
import { z } from 'zod';
import { initMetaClient, closeMetaClient } from '../src/db/meta-client.js';
import { encryptObject, validateEncryptionKey } from '../src/utils/encryption.js';
import { extractErrorDetails } from '../src/utils/error.js';
import { TwitchAuthSchema, TwitchAuthObject, TwitchSchema } from '../src/config/schemas.js';
import { getTenantById, updateTenant } from '../src/services/meta-tenants.service.js';
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

const TwitchTokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  token_type: z.string(),
});

async function main(): Promise<void> {
  let tenantIdToUpdate: string | null = null;

  try {
    await initMetaClient();
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
    const tenant = await getTenantById(tenantId);

    if (!tenant) {
      console.error('\n❌ Tenant not found:', tenantId);
      console.error('   Make sure the tenant ID is correct and exists in your database.');
      process.exit(1);
    }

    console.log(`\n✓ Tenant found!`);

    // Display current Twitch status
    const twitchParsed = TwitchSchema.safeParse(tenant.twitch);
    const hasTwitchAuth = twitchParsed.success && twitchParsed.data.auth !== undefined;

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

    let oauthResult: z.infer<typeof TwitchTokenResponseSchema>;
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

      const rawData = await response.json();
      oauthResult = TwitchTokenResponseSchema.parse(rawData);
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

    const twitchAuthObject: TwitchAuthObject = {
      client_id: clientId,
      client_secret: clientSecret,
      access_token: oauthResult.access_token,
      expiry_date: expiryDate,
    };

    // Validate before encryption
    TwitchAuthSchema.parse(twitchAuthObject);

    console.log('\nEncrypting credentials with AES-256-GCM...');

    const encryptedTwitchAuth = encryptObject(twitchAuthObject);

    // Phase 5: Update Meta DB (preserve existing config)
    console.log(`Storing in meta database for tenant "${tenantId}"...\n`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let updatedTwitchConfig: any;

    if (tenant.twitch) {
      const existing = TwitchSchema.safeParse(tenant.twitch);

      if (existing.success) {
        // Preserve existing fields like username, id, etc.
        updatedTwitchConfig = {
          enabled: true,
          mainPlatform: existing.data.mainPlatform || false,
          username: existing.data.username ?? undefined,
          id: existing.data.id ?? undefined,
          auth: encryptedTwitchAuth,
        };
      } else {
        // If parsing fails, start fresh with just the new auth
        updatedTwitchConfig = {
          enabled: true,
          mainPlatform: false,
          username: undefined,
          id: undefined,
          auth: encryptedTwitchAuth,
        };
      }
    } else {
      updatedTwitchConfig = {
        enabled: true,
        mainPlatform: false,
        username: undefined,
        id: undefined,
        auth: encryptedTwitchAuth,
      };
    }

    await updateTenant(tenantId, { twitch: updatedTwitchConfig });

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
        const { deleteTenant } = await import('../src/services/meta-tenants.service.js');
        await deleteTenant(tenantIdToUpdate);
        console.log('✓ Rolled back changes from meta DB');
      } catch (rollbackError) {
        const rollbackDetails = extractErrorDetails(rollbackError);
        console.error('⚠️  Could not rollback:', rollbackDetails.message);
      }
    }

    process.exit(1);
  } finally {
    rl.close();
    await closeMetaClient();
  }
}

main();
