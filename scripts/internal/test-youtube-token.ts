#!/usr/bin/env node
import 'dotenv/config';
import { program } from 'commander';
import { metaClient } from '../../src/db/meta-client.js';
import { extractErrorDetails } from '../../src/utils/error.js';
import { decryptScalar, decryptObject } from '../../src/utils/encryption.js';
import { loadTenantConfigs } from '../../src/config/loader.js';
import { validateYoutubeToken } from '../../src/services/youtube/index.js';
import { humanizeDuration } from '../../src/utils/formatting.js';

interface YoutubeAuth {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expiry_date: number;
}

async function decryptYoutubeAuth(encryptedValue: any): Promise<YoutubeAuth | null> {
  // Auth is stored as encrypted JSON string (using encryptScalar on the JSON)
  try {
    const decryptedString = decryptScalar(encryptedValue);
    return typeof decryptedString === 'string' ? JSON.parse(decryptedString) : null;
  } catch (_e) {
    // Fallback: if it's already an encrypted object, use decryptObject
    return decryptObject<YoutubeAuth>(encryptedValue);
  }
}

program
  .name('test-youtube-token')
  .description('Test YouTube OAuth token persistence and refresh functionality')
  .option('-t, --tenant <id>', 'Tenant ID to test (auto-select if not specified)')
  .option('--force-refresh', 'Force a new token refresh via Google API')
  .option('-v, --verbose', 'Show detailed output including full token objects')
  .option('--check-only', 'Only check current state without forcing refresh')
  .action(async (options: { tenant?: string; forceRefresh: boolean; verbose: boolean; checkOnly: boolean }) => {
    console.log('YouTube Token Test');
    console.log('==================\n');

    let tenantId = options.tenant;

    if (!tenantId) {
      const tenants = await metaClient.tenant.findMany();
      if (tenants.length === 0) {
        console.error('No tenants found. Please create one first using scripts/create-tenant.ts');
        process.exit(1);
      }

      tenantId = tenants[0].id;
      console.log(`Using tenant: ${tenantId}`);
    }

    try {
      const tenantWithYoutube = await metaClient.tenant.findFirst({
        where: { id: tenantId },
      });

      if (!tenantWithYoutube) {
        console.error('Tenant not found');
        process.exit(1);
      }

      // YouTube auth is stored in youtube.auth (encrypted string inside JSON object)
      const youtubeConfig = tenantWithYoutube.youtube as any;

      if (!youtubeConfig || !youtubeConfig.auth) {
        console.error('YouTube credentials not found. Run scripts/auth-youtube.ts first.');
        process.exit(1);
      }

      let decrypted = await decryptYoutubeAuth(youtubeConfig.auth);

      if (!decrypted) {
        console.error('Failed to decrypt YouTube auth data');
        process.exit(1);
      }

      console.log('\nCurrent Token State:');
      console.log('-'.repeat(50));

      displayTokenState(decrypted, 'Before', options.verbose);

      if (options.forceRefresh && !options.checkOnly) {
        // Clear cache to force fresh read from DB after refresh

        console.log('\nForcing token refresh...');

        try {
          // Load configs first to populate cache for youtube service (critical!)
          console.log('Loading streamer configs from DB...');
          await loadTenantConfigs();

          // Use getAccessToken which will trigger the tokens event and persist changes
          if (decrypted.refresh_token) {
            console.log('✅ Refresh token available - attempting API refresh via validateYoutubeToken()');

            const isValid = await validateYoutubeToken(tenantId);

            if (!isValid) {
              console.error('❌ Token validation failed');
              process.exit(1);
            }

            console.log('✅ Token refreshed successfully!');

            // Wait for async DB persistence to complete (tokens event handler is synchronous but uses async/await internally)
            await new Promise((resolve) => setTimeout(resolve, 500));
          } else {
            console.error('No refresh token found - cannot force refresh');
            process.exit(1);
          }
        } catch (err: any) {
          if (err.message?.includes('invalid_grant') || err.message?.includes('token_expired')) {
            console.error('\n❌ FAIL: Refresh token is expired or invalid');
            throw new Error('Refresh failed - please re-authenticate using scripts/auth-youtube.ts');
          } else {
            throw err;
          }
        }

        const updatedTenant = await metaClient.tenant.findFirst({
          where: { id: tenantId },
        });

        if (!updatedTenant || !(updatedTenant.youtube as any)?.auth) {
          console.error('Error: YouTube credentials missing after refresh');
          process.exit(1);
        }

        const updatedYoutubeConfig = updatedTenant.youtube as any;

        let decryptedAfter = await decryptYoutubeAuth(updatedYoutubeConfig.auth);

        if (!decryptedAfter) {
          console.error('Failed to decrypt YouTube auth data after refresh');
          process.exit(1);
        }

        console.log('\n\nToken State After Refresh:');
        console.log('-'.repeat(50));
        displayTokenState(decryptedAfter, 'After', options.verbose);
      } else if (options.checkOnly) {
        console.log('Mode: Check-only (--check-only). No refresh performed.');
      }
    } catch (error) {
      const details = extractErrorDetails(error);
      console.error('Error:', details.message);
      process.exit(1);
    } finally {
      await metaClient.$disconnect();
    }
  });

program.parse(process.argv);

function displayTokenState(auth: YoutubeAuth, label: string, verbose = false) {
  console.log(`\n[${label}]`);

  const nowMs = Date.now();
  const expiryDate = auth.expiry_date || null;
  let statusText = 'Unknown';

  if (expiryDate && typeof expiryDate === 'number') {
    const expiresAt = new Date(expiryDate).toLocaleString('en-US', { dateStyle: 'full' });
    const remainingSecs = Math.floor((expiryDate - nowMs) / 1000);

    if (remainingSecs < 60) {
      statusText = `EXPIRED (${expiresAt})`;
    } else {
      statusText = `${humanizeDuration(remainingSecs)} remaining (Expires: ${expiresAt})`;
    }
  }

  console.log(`Status: ${statusText}`);

  if (auth.access_token) {
    const tokenPreview = auth.access_token.length > 20 ? `...${auth.access_token.slice(-15)}` : auth.access_token;
    console.log(`Access Token: [PRESENT] (${tokenPreview})`);
  } else {
    console.log('Access Token: [MISSING]');
  }

  if (auth.refresh_token) {
    const tokenPreview = auth.refresh_token.length > 20 ? `...${auth.refresh_token.slice(-15)}` : auth.refresh_token;
    console.log(`Refresh Token: [PRESENT] (${tokenPreview})`);
  } else {
    console.log('Refresh Token: [MISSING]');
  }

  if (verbose && auth.access_token) {
    const tokenPreview = auth.access_token.length > 20 ? `...${auth.access_token.slice(-15)}` : auth.access_token;
    console.log(`Access Token Full: ${tokenPreview} [Full length: ${auth.access_token?.length || 0}]`);
  }

  if (verbose && auth.refresh_token) {
    const tokenPreview = auth.refresh_token.length > 20 ? `...${auth.refresh_token.slice(-15)}` : auth.refresh_token;
    console.log(`Refresh Token Full: ${tokenPreview} [Full length: ${auth.refresh_token?.length || 0}]`);
  }

  if (expiryDate && typeof expiryDate === 'number') {
    const dateObj = new Date(expiryDate);
    console.log(`Absolute Timestamp: ${dateObj.toISOString()} (${expiryDate})`);

    // Validation check for absolute vs relative format
    const isRelativeFormat = expiryDate < 10000000;
    if (isRelativeFormat) {
      console.log('❌ FAIL: Expiry date appears to be in relative seconds format');
      console.log(`   Expected: Absolute timestamp (milliseconds since epoch, e.g., ${nowMs})`);
      console.log(`   Got: ${expiryDate} (${new Date(expiryDate * 1000).toLocaleString()})`);
    } else {
      const expectedMin = nowMs - 86400000;
      if (expiryDate >= expectedMin && expiryDate <= nowMs + 7200000) {
        console.log('✅ PASS: Expiry date is valid absolute timestamp');
      } else {
        console.log(`⚠️  WARNING: Timestamp seems unusual but not invalid`);
      }
    }
  }

  if (!auth.access_token && !auth.refresh_token) {
    console.log('\n❌ FAIL: No tokens present in auth object');
  } else {
    const hasExpiry = expiryDate !== null;
    if (hasExpiry) {
      console.log('\n✅ PASS: Complete auth object with all required fields');
    } else {
      console.log('\n❌ FAIL: Missing expiry_date field');
    }
  }

  return statusText.includes('EXPIRED') || (!auth.access_token && !auth.refresh_token) || (expiryDate !== null ? typeof expiryDate === 'number' && expiryDate < 10000000 : false);
}
