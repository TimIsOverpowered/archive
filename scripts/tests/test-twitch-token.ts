#!/usr/bin/env node
import 'dotenv/config';
import { program } from 'commander';
import { initMetaClient, closeMetaClient } from '../../src/db/meta-client.js';
import { extractErrorDetails } from '../../src/utils/error.js';
import { configService, buildTenantConfig } from '../../src/config/tenant-config.js';
import { getAppAccessToken } from '../../src/services/twitch/index.js';
import { getTwitchCredentials } from '../../src/utils/credentials.js';
import { humanizeDuration } from '../../src/utils/formatting.js';
import { getAllTenants, getTenantById } from '../../src/services/meta-tenants.service.js';

interface TwitchAuth {
  client_id: string;
  client_secret: string;
  access_token?: string | undefined;
  expiry_date?: number | undefined;
}

program
  .name('test-twitch-token')
  .description('Test Twitch OAuth token persistence, validation, and refresh functionality')
  .option('-t, --tenant <id>', 'Tenant ID to test (auto-select if not specified)')
  .option('--force-refresh', 'Force a new token refresh via Twitch API')
  .option('-v, --verbose', 'Show detailed output including full API responses')
  .option('--check-only', 'Only check current state without making API calls')
  .option('--validate-token', 'Validate current token by making a test API call to /helix/users')
  .action(
    async (options: {
      tenant?: string;
      forceRefresh: boolean;
      verbose: boolean;
      checkOnly: boolean;
      validateToken: boolean;
    }) => {
      await initMetaClient();
      console.log('Twitch Token Test');
      console.log('==================\n');

      let tenantId = options.tenant;

      if (!tenantId) {
        const tenants = await getAllTenants();
        if (tenants.length === 0) {
          console.error('No tenants found. Please create one first using scripts/create-tenant.ts');
          process.exit(1);
        }

        const firstTenant = tenants[0];
        if (!firstTenant) {
          console.error('No tenant found');
          process.exit(1);
        }
        tenantId = firstTenant.id;
        console.log(`Using tenant: ${tenantId}`);
      }

      try {
        const tenant = await getTenantById(tenantId);

        if (!tenant) {
          console.error('Tenant not found');
          process.exit(1);
        }

        const config = buildTenantConfig(tenant);

        if (!config?.twitch?.auth) {
          console.error('Twitch credentials not found. Run scripts/auth-twitch.ts first.');
          process.exit(1);
        }

        let decrypted = JSON.parse(config.twitch.auth!) as TwitchAuth;

        console.log('\nCurrent Token State:');
        console.log('-'.repeat(50));

        const hasIssuesBefore = displayTokenState(decrypted, 'Before', options.verbose);

        if (options.forceRefresh) {
          console.log('\nForcing token refresh...');

          console.log('Loading streamer configs from DB...');
          await configService.loadAll();

          try {
            const newToken = await getAppAccessToken(tenantId);
            console.log('✅ Token refreshed successfully!');
            console.log(`   New token: ${newToken.substring(0, 20)}...${newToken.slice(-10)}`);

            await new Promise((resolve) => setTimeout(resolve, 500));

            const updatedTenant = await getTenantById(tenantId);

            if (!updatedTenant) {
              console.error('Error: Tenant not found after refresh');
              process.exit(1);
            }

            const configAfter = buildTenantConfig(updatedTenant);

            if (!configAfter?.twitch?.auth) {
              console.error('Failed to decrypt Twitch auth data after refresh');
              process.exit(1);
            }

            let decryptedAfter = JSON.parse(configAfter.twitch.auth!) as TwitchAuth;

            console.log('\n\nToken State After Refresh:');
            console.log('-'.repeat(50));
            displayTokenState(decryptedAfter, 'After', options.verbose);
          } catch (err: any) {
            const details = extractErrorDetails(err);
            console.error('\n❌ FAIL: Token refresh failed');
            console.error(`   Error: ${details.message}`);

            if (options.verbose && err?.rawResponse) {
              console.error('\nRaw API Response:');
              console.error(JSON.stringify(err.rawResponse, null, 2));
            }

            if (details.message.includes('403')) {
              console.error('\n⚠️  403 Forbidden indicates invalid or revoked credentials.');
              console.error('   Run "npm run auth:twitch" to re-authenticate with fresh credentials.');
            } else if (details.message.includes('400')) {
              console.error('\n⚠️  400 Bad Request indicates malformed request or invalid client credentials.');
            } else if (details.message.includes('429')) {
              console.error('\n⚠️  429 Too Many Requests - Twitch has rate-limited your app.');
              console.error('   Wait a few minutes and try again.');
            }

            process.exit(1);
          }
        } else if (options.validateToken) {
          console.log('\nValidating current token...');

          await configService.loadAll();

          try {
            const accessToken = await getAppAccessToken(tenantId);

            if (!accessToken || accessToken === null) {
              console.error('❌ FAIL: Could not get access token');
              process.exit(1);
            }

            const creds = getTwitchCredentials(tenantId);

            if (!creds || !creds.clientId) {
              console.error('❌ FAIL: Could not retrieve credentials');
              process.exit(1);
            }

            const url = new URL('https://api.twitch.tv/helix/users');
            url.searchParams.append('login', '');

            const response = await fetch(url.toString(), {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Client-Id': creds.clientId,
              },
              signal: AbortSignal.timeout(10000),
            });

            if (!response.ok) {
              const errorBody = await response.text().catch(() => 'Unable to read response body');
              console.error(`\n❌ FAIL: Token validation failed with status ${response.status} ${response.statusText}`);

              if (options.verbose) {
                console.error('\nRaw API Response:');
                console.error(errorBody);
              }

              if (response.status === 401) {
                console.error('\n⚠️  401 Unauthorized - token is expired or invalid.');
                console.error('   Run with --force-refresh to get a new token.');
              } else if (response.status === 403) {
                console.error('\n⚠️  403 Forbidden - credentials may be revoked.');
                console.error('   Run "npm run auth:twitch" to re-authenticate.');
              }

              process.exit(1);
            }

            const data = await response.json();
            console.log('✅ Token is valid and working!');
            console.log(`   API returned ${response.status} OK`);

            if (options.verbose) {
              console.log('\nAPI Response (first 200 chars):');
              const responseStr = JSON.stringify(data);
              console.log(responseStr.substring(0, 200) + (responseStr.length > 200 ? '...' : ''));
            }
          } catch (err: any) {
            const details = extractErrorDetails(err);
            console.error('\n❌ FAIL: Token validation error');
            console.error(`   Error: ${details.message}`);

            if (options.verbose) {
              console.error('\nFull error details:');
              console.error(details.stack || details.message);
            }

            process.exit(1);
          }
        } else if (options.checkOnly) {
          console.log('\nMode: Check-only (--check-only). No API calls made.');

          if (hasIssuesBefore) {
            console.error('\n❌ Token has issues (see above)');
            process.exit(1);
          }
        }
      } catch (error) {
        const details = extractErrorDetails(error);
        console.error('Error:', details.message);
        if (options.verbose && details.stack) {
          console.error('\nStack trace:');
          console.error(details.stack);
        }
        process.exit(1);
      } finally {
        await closeMetaClient();
      }
    }
  );

program.parse(process.argv);

function displayTokenState(auth: TwitchAuth, label: string, verbose = false): boolean {
  console.log(`\n[${label}]`);

  const nowMs = Date.now();
  const expiryDate = auth.expiry_date || null;
  let hasIssues = false;

  console.log('\nCredential Status:');
  console.log('-'.repeat(30));

  if (auth.client_id) {
    const preview = auth.client_id.length > 12 ? `${auth.client_id.substring(0, 12)}...` : auth.client_id;
    console.log(`Client ID: [PRESENT] (${preview})`);
  } else {
    console.log('Client ID: [MISSING] ❌');
    hasIssues = true;
  }

  if (auth.client_secret) {
    console.log('Client Secret: [PRESENT] (***REDACTED***)');
  } else {
    console.log('Client Secret: [MISSING] ❌');
    hasIssues = true;
  }

  if (auth.access_token) {
    const tokenPreview = auth.access_token.length > 20 ? `...${auth.access_token.slice(-15)}` : auth.access_token;
    console.log(`Access Token: [PRESENT] (${tokenPreview})`);
  } else {
    console.log('Access Token: [MISSING] ❌');
    hasIssues = true;
  }

  if (expiryDate && typeof expiryDate === 'number') {
    const expiresAt = new Date(expiryDate).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' });
    const remainingSecs = Math.floor((expiryDate - nowMs) / 1000);

    if (remainingSecs < 0) {
      console.log(`\nToken Status: EXPIRED (${expiresAt}) ❌`);
      hasIssues = true;
    } else if (remainingSecs < 60) {
      console.log(`\nToken Status: EXPIRING SOON (${humanizeDuration(remainingSecs)} remaining) ⚠️`);
      hasIssues = true;
    } else {
      console.log(`\nToken Status: VALID (${humanizeDuration(remainingSecs)} remaining) ✅`);
      console.log(`Expires: ${expiresAt}`);
    }

    if (verbose) {
      const dateObj = new Date(expiryDate);
      console.log(`Absolute Timestamp: ${dateObj.toISOString()} (${expiryDate})`);

      const isRelativeFormat = expiryDate < 10000000;
      if (isRelativeFormat) {
        console.log('❌ FAIL: Expiry date appears to be in relative seconds format');
        console.log(`   Expected: Absolute timestamp (milliseconds since epoch, e.g., ${nowMs})`);
        console.log(`   Got: ${expiryDate} (${new Date(expiryDate * 1000).toLocaleString()})`);
        hasIssues = true;
      } else {
        const expectedMin = nowMs - 86400000;
        if (expiryDate >= expectedMin && expiryDate <= nowMs + 7200000) {
          console.log('✅ Expiry date is valid absolute timestamp');
        } else {
          console.log('⚠️  WARNING: Timestamp seems unusual but not invalid');
        }
      }
    }
  } else {
    console.log('\nToken Status: UNKNOWN (no expiry_date field) ❌');
    hasIssues = true;
  }

  if (verbose && auth.access_token) {
    console.log(`\nAccess Token Length: ${auth.access_token.length} characters`);
  }

  console.log('\nValidation Summary:');
  console.log('-'.repeat(30));

  const hasAllFields = auth.client_id && auth.client_secret && auth.access_token && expiryDate;
  if (hasAllFields && !hasIssues) {
    console.log('✅ PASS: Complete auth object with all required fields and valid token');
  } else if (!hasAllFields) {
    console.log('❌ FAIL: Missing required fields in auth object');
  } else {
    console.log('⚠️  WARNING: Auth object has issues (see above)');
  }

  return hasIssues;
}
