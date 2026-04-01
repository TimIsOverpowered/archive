#!/usr/bin/env node

// Load environment variables FIRST using side-effect import (hoisted by ESM)
import 'dotenv/config';

import { program } from 'commander';
import fetch from 'node-fetch';
import crypto from 'crypto';
import http from 'http';
import open from 'open';
import readline from 'readline';
import { metaClient } from '../src/db/meta-client.js';
import { extractErrorDetails } from '../src/utils/error.js';

program.name('auth-youtube').description('YouTube OAuth authentication CLI tool').version('1.0.0');

interface Tenant {
  id: string;
  displayName: string;
  youtube?: any;
}

let callbackServer: http.Server | null = null;

async function waitForUserInput(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    console.log('\nPaste the authorization code or full callback URL here when ready:');

    rl.question('> ', (answer) => {
      resolve(answer.trim());
      rl.close();
    });
  });
}

function extractAuthCode(input: string, expectedState: string): { error?: string } {
  if (!input || input.length < 10) {
    return { error: 'Input too short. Please paste the full callback URL or authorization code.' };
  }

  // Check if it's a full URL with query params
  if (input.startsWith('http://') || input.startsWith('https://')) {
    try {
      const urlObj = new URL(input);

      // Validate state matches to prevent CSRF attacks
      const receivedState = urlObj.searchParams.get('state');
      if (!receivedState) {
        return { error: 'No state parameter found in callback URL. This may be an invalid or expired code.' };
      }

      if (receivedState !== expectedState) {
        const preview = receivedState?.substring(0, 16) || 'null';
        return { error: `Session mismatch! Expected state: ${expectedState.substring(0, 16)}..., Received: ${preview}...` };
      }

      const receivedCode = urlObj.searchParams.get('code');
      if (!receivedCode) {
        return { error: 'No authorization code found in callback URL.' };
      }

      return {}; // Valid - no errors
    } catch (parseError: any) {
      return { error: `Could not parse the provided URL. Please ensure it's a valid callback URL from Google.` };
    }
  } else {
    // User pasted raw auth code directly
    console.warn('\n⚠️ Note: Pasting raw authorization codes without state validation is less secure.');

    return {}; // Accept but warn - no errors
  }
}

function showManualPasteInstructions(authUrl: string, tenantId: string): void {
  console.log('\n=== YouTube OAuth Authentication ===\n');

  console.log(`Tenant ID: ${tenantId}\n`);

  console.log('Step 1 - Open URL on any device with browser access:');
  console.log('───────────────────────────────\n');

  console.log(authUrl + '\n');

  console.log('\nStep 2 - Get the callback URL or authorization code after authorizing:');
  console.log('───────────────────────────────\n');

  console.log('After authorizing, Google will redirect to a page like:\n');
  console.log(`http://localhost:9999/callback?code=4/0A...&state=abc123...\n`);

  console.log('\nStep 3 - Paste the URL here below:');
  console.log('───────────────────────────────\n');

  console.log('Copy and paste either:\n');
  console.log(`• The full callback URL from your browser's address bar, OR`);
  console.log(`• Just the authorization code (the value after "code=" in the URL)\n`);
}

async function getTenant(streamerIdOrName: string): Promise<Tenant | null> {
  try {
    let tenant: Tenant | null = null;

    // Try direct ID lookup first
    tenant = await metaClient.tenant.findUnique({
      where: { id: streamerIdOrName },
    });

    if (!tenant) {
      console.error(`Tenant not found: ${streamerIdOrName}`);
      return null;
    }

    return tenant as Tenant;
    return tenant as Tenant;
  } catch (error: unknown) {
    console.error('Error getting tenant:', typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error));
    return null;
  }
}

async function startOAuthFlow(tenantId: string): Promise<void> {
  const state = crypto.randomBytes(32).toString('hex');
  const scopes = ['https://www.googleapis.com/auth/youtube.force-ssl', 'https://www.googleapis.com/auth/youtube', 'https://www.googleapis.com/auth/youtube.upload'].join(' ');

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', process.env.YOUTUBE_CLIENT_ID || '');
  authUrl.searchParams.set('redirect_uri', 'http://localhost:9999/callback');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', scopes);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('access_type', 'offline'); // Required to get refresh_token
  authUrl.searchParams.set('prompt', 'consent select_account'); // Force re-consent for fresh tokens

  if (process.argv.includes('--open')) {
    await open(authUrl.toString());

    console.log('\n=== YouTube OAuth Authentication ===\n');
    console.log(`Mode: Browser`);
    console.log(`Tenant ID: ${tenantId}\n`);

    startCallbackServer(tenantId, state);
  } else {
    showManualPasteInstructions(authUrl.toString(), tenantId);

    const userInput = await waitForUserInput();

    if (!userInput) {
      throw new Error('No input provided. Please try again.');
    }

    // Extract auth code from pasted URL or raw code
    const extractedData = extractAuthCode(userInput, state);

    if (extractedData.error) {
      console.error(`Error: ${extractedData.error}`);
      process.exit(1);
    }

    await completeOAuth(tenantId, state, userInput);
  }
}

function startCallbackServer(streamerId: string, expectedState: string): void {
  callbackServer = http.createServer(async (req, res) => {
    if (!req.url || !req.url.startsWith('/callback')) {
      const isRoot = req.url === '/';

      if (isRoot) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.write(`<!DOCTYPE html>
<html><head><title>YouTube OAuth Callback</title></head>
<body style="font-family: sans-serif; text-align: center;">
  <h1>You can close this browser window</h1>
  <p>The authentication process is still running in the terminal.</p>
</body></html>`);
        res.end();
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }

      return;
    }

    try {
      const urlObj = new URL(req.url, 'http://localhost:9999');

      // Complete OAuth flow and store auth object (returns true on success)
      await completeOAuth(streamerId, expectedState, urlObj.href);

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.write(`<!DOCTYPE html>
<html><head><title>YouTube Authentication Successful</title></head>
<body style="font-family: sans-serif; text-align: center;">
  <h1>✓ Authentication Successful!</h1>
  <p>Your YouTube credentials have been stored securely.</p>
  <p>You can close this browser window now.</p>
  <script>window.close();</script>
</body></html>`);
      res.end();

      // Close server and exit after sending response (use setTimeout to ensure response is flushed)
      callbackServer?.close(() => {
        console.log('\n✓ Callback server closed. Authentication complete.');
        process.exit(0);
      });
    } catch (error: unknown) {
      const message = typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error);
      res.write(`<!DOCTYPE html><html><head><title>Authentication Failed</title></head>
<body style="font-family: sans-serif; text-align: center;">
  <h1>✗ Authentication Failed</h1>
  <p>Please check the terminal for details.</p>
  <script>window.close();</script>
</body></html>`);
      res.end();

      callbackServer?.close(() => {
        process.exit(1);
      });
    }
  });

  callbackServer.listen(9999, () => {
    console.log(`Callback server running at http://localhost:9999`);
  });
}

async function completeOAuth(streamerId: string, expectedState: string, urlOrCode: string): Promise<boolean> {
  let code = '';

  if (urlOrCode.startsWith('http')) {
    const urlObj = new URL(urlOrCode);
    const stateParam = urlObj.searchParams.get('state');
    const receivedCode = urlObj.searchParams.get('code');

    console.log(`\nReceived callback with state: ${stateParam}`);
    console.log(`Expected state: ${expectedState}`);

    // Check for OAuth errors from Google first
    if (urlOrCode.includes('error=')) {
      const allParams = urlObj.search
        .slice(1)
        .split('&')
        .reduce<Record<string, string>>((acc, pair) => {
          const [key, value] = pair.split('=');
          acc[decodeURIComponent(key)] = decodeURIComponent(value || '');
          return acc;
        }, {});

      console.error('\n=== OAuth Error from Google ===');
      Object.entries(allParams).forEach(([key, value]) => {
        if (key !== 'redirect_uri') {
          console.log(`${key}: ${value}`);
        }
      });
      process.exit(1);
    }

    // Validate state token matches to prevent CSRF attacks and ensure single-session auth
    if (!stateParam || stateParam !== expectedState) {
      console.error('\n=== Session Expired or Invalid ===');
      console.error(`Expected state: ${expectedState.substring(0, 16)}...`);
      console.error(`Received state: ${stateParam?.substring(0, 16) || 'null'}...\n`);
      throw new Error('Session expired. Please restart the authentication process.');
    }

    // Extract authorization code
    if (!receivedCode) {
      throw new Error('No authorization code in callback URL');
    }

    code = receivedCode;
  } else {
    code = urlOrCode;
  }

  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        code,
        client_id: process.env.YOUTUBE_CLIENT_ID || '',
        client_secret: process.env.YOUTUBE_CLIENT_SECRET || '',
        redirect_uri: 'http://localhost:9999/callback',
        grant_type: 'authorization_code',
      }),
    });

    const tokenData: any = await response.json();

    if (!response.ok) {
      console.error('Token exchange failed:', tokenData);
      process.exit(1);
    }

    // Debug log to see what Google returned
    console.log('\n=== Raw Token Response from Google ===');
    console.log('access_token present:', !!tokenData.access_token, `(${tokenData.access_token?.length || 0} chars)`);
    console.log('refresh_token present:', !!tokenData.refresh_token, `(value: "${tokenData.refresh_token}" - ${typeof tokenData.refresh_token})`);
    console.log('expires_in:', tokenData.expiresIn || tokenData.expires_in);
    console.log('scope:', tokenData.scope?.substring(0, 100) + '...');

    // Convert Google's relative expiry to absolute timestamp for consistency across all components (Option A per user choice)
    const expiresInSeconds =
      typeof tokenData.expiresIn === 'number'
        ? tokenData.expiresIn // camelCase variant from googleapis library
        : typeof tokenData.expires_in === 'number'
          ? tokenData.expires_in
          : undefined;

    // Build normalized auth object with absolute timestamp format used throughout codebase
    const authObject: any = {
      type: 'auth', // Keep for backward compatibility checks in storeAuthObject() line 279

      access_token: tokenData.access_token, // Required - current valid short-lived token
      refresh_token: tokenData.refresh_token || '', // Required - long-lived per-tenant unique value

      expiry_date:
        expiresInSeconds !== undefined
          ? Date.now() + expiresInSeconds * 1000 // Convert relative seconds to absolute timestamp in ms
          : typeof tokenData.expiry_date === 'number'
            ? tokenData.expiry_date
            : Date.now() + 3600_000, // Fallback: default 1 hour

      scope: tokenData.scope, // Optional - preserve OAuth grant scopes
    };

    // Include optional fields from Google response if present
    if (tokenData.token_type) authObject.token_type = tokenData.token_type;

    console.log('\n=== Authentication Successful ===\n');
    console.log(`Stream ID: ${streamerId}`);
    console.log('Token received. Storing encrypted authentication object in database...\n');

    await storeAuthObject(streamerId, authObject as any);

    return true; // Signal success to caller
  } catch (error) {
    const details = extractErrorDetails(error);
    console.error('[OAuth] Token exchange error:', details.message);
    throw error;
  }
}

async function storeAuthObject(tenantId: string, authObject: any): Promise<void> {
  if (!process.env.META_DATABASE_URL) {
    throw new Error('META_DATABASE_URL is required for storing auth object');
  }

  try {
    // Import encryption utilities (lazy import to avoid circular deps)
    const { encryptScalar, decryptObject } = await import('../src/utils/encryption.js');

    // Get current tenant record
    const tenant = await metaClient.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new Error(`Tenant not found in database: ${tenantId}`);

    console.log('Using encryption for auth object storage.');

    // Decrypt existing YouTube config to preserve settings while updating only .auth field
    let youtubeConfig: any = {};

    const currentYoutubeValue = (tenant as any).youtube;

    if (currentYoutubeValue) {
      try {
        // Try decrypting the stored value first
        const decryptedValue = decryptObject(currentYoutubeValue);

        // If decryption succeeds, use it directly - should be an object with youtube config fields
        if (typeof decryptedValue === 'object' && decryptedValue !== null) {
          console.log('Preserving existing YouTube configuration...');
          youtubeConfig = decryptedValue;

          // Check if previous run stored only auth token as string instead of full config
          const hasAuthFieldOnly = Object.keys(youtubeConfig).length > 0 && (youtubeConfig.type === 'auth' || youtubeConfig.refresh_token);

          if (!hasAuthFieldOnly) {
            console.log(`Preserved ${Object.keys(youtubeConfig).length} YouTube settings from database.`);
          } else {
            console.log('Previous data was OAuth token only. Keeping it in new structure.');
          }
        } else {
          // Decryption returned non-object (string, number, etc.) - unexpected format
          console.warn(`Unexpected decrypted type: ${typeof decryptedValue}. Starting with clean config.`);
          youtubeConfig = {};
        }
      } catch (decryptError) {
        // Failed to decrypt - previous data might be unencrypted JSON or invalid
        try {
          const parsedJson = typeof currentYoutubeValue === 'string' ? JSON.parse(currentYoutubeValue) : currentYoutubeValue;

          if (typeof parsedJson === 'object') {
            console.log('Using existing YouTube config from database (unencrypted)...');
            youtubeConfig = parsedJson;
          } else {
            console.warn(`Could not parse previous YouTube data. Starting with clean slate.`);
            youtubeConfig = {};
          }
        } catch (parseError) {
          // Completely invalid/unknown format - start fresh
          console.warn('Previous YouTube config could not be parsed or decrypted. Starting with new configuration.');
          youtubeConfig = {};
        }
      }
    } else {
      console.log('No existing YouTube configuration found. Creating new structure.');
    }

    // Update ONLY the .auth subfield - encrypt it separately so it stays encrypted in DB
    const encryptedAuthValue = encryptScalar(JSON.stringify(authObject));

    youtubeConfig.auth = encryptedAuthValue;

    // Store as JSON object (Prisma handles serialization properly) - DO NOT stringify here!
    await metaClient.tenant.update({
      where: { id: tenantId },
      data: { youtube: youtubeConfig }, // Pass raw JS object, not stringified version!
    });

    console.log('\n=== Auth Object Stored Successfully ===\n');
} catch (error: unknown) {
      const isTenantNotFound = typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2025';
      
      if (isTenantNotFound) {
        throw new Error(`Tenant not found in database: ${tenantId}`);
      }
}

program
  .argument('<streamer_id>', 'Streamer ID or display name to authenticate')
  .option('--open', 'Automatically open browser for OAuth flow and start callback server (default: manual paste mode)')

  .action(async (streamerId: string, options) => {
    const tenant = await getTenant(streamerId);

    if (!tenant) {
      console.error('Failed to load tenant. Please verify the streamer ID or display name.');
      process.exit(1);
    }

    startOAuthFlow(tenant.id).catch((error: unknown) => {
      const details = extractErrorDetails(error);
      callbackServer?.close();
      process.exit(1);
    });
  });

program.parse(process.argv);
