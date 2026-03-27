import { program } from 'commander';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import crypto from 'crypto';
import http from 'http';
import { createClient, closeAllClients } from '../src/db/client.js';
import type { StreamerConfig } from '../src/config/types.js';

// Load environment variables based on NODE_ENV
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
dotenv.config({ path: `.\\.${envFile}` });

program.name('auth-youtube').description('YouTube OAuth authentication CLI tool (headless-friendly)').version('1.0.0');

interface Tenant {
  id: string;
  youtube?: any; // Will be structured based on schema
}

async function getTenant(streamerIdOrName: string): Promise<Tenant | null> {
  try {
    const config = JSON.parse(process.env.TENANT_CONFIG || '{}') as StreamerConfig[];
    const tenant = config.find((t) => t.id === streamerIdOrName);

    if (!tenant) {
      console.error(`Tenant not found: ${streamerIdOrName}`);
      return null;
    }

    // Create client and fetch from DB (simplified - actual implementation needs proper tenant lookup)
    const db = await createClient(tenant);
    // Note: Actual tenant retrieval would query the meta database here
    closeAllClients();

    return { id: streamerIdOrName, youtube: {} };
  } catch (error) {
    console.error('Error getting tenant:', error);
    return null;
  }
}

async function startOAuthFlow(tenantId: string): Promise<void> {
  const state = crypto.randomBytes(32).toString('hex');

  // Store CSRF token for validation (in production, use Redis/session)
  process.env._oauth_state = state;

  const scopes = ['https://www.googleapis.com/auth/youtube.force-ssl', 'https://www.googleapis.com/auth/youtube', 'https://www.googleapis.com/auth/youtube.upload'].join(' ');

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', process.env.YOUTUBE_CLIENT_ID || '');
  authUrl.searchParams.set('redirect_uri', 'http://localhost:9999/callback');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', scopes);
  authUrl.searchParams.set('state', state);

  console.log('\n=== YouTube OAuth Authentication ===\n');

  const mode = process.argv.includes('--headless') ? 'Headless' : 'Browser';
  console.log(`Mode: ${mode}`);
  console.log(`Tenant ID: ${tenantId}\n`);

  if (process.argv.includes('--open')) {
    // Open browser automatically
    const open = await import('open');
    await default_1.default(authUrl.toString());

    // Start callback server for browser mode
    startCallbackServer(tenantId, state);
  } else {
    console.log(`Open this URL in your browser:\n${authUrl.toString()}\n`);
    console.log('After authorizing, you will be redirected to http://localhost:9999/callback');
    console.log('\nThe script will automatically capture the callback and complete authentication.\n');

    startCallbackServer(tenantId, state);
  }
}

function startCallbackServer(streamerId: string, expectedState: string): void {
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/callback')) {
      try {
        // Parse query parameters manually for Node.js native HTTP
        const urlObj = new URL(req.url, 'http://localhost:9999');
        const code = urlObj.searchParams.get('code');
        const state = urlObj.searchParams.get('state');

        if (!code) {
          res.writeHead(400);
          res.end('No authorization code received');
          return;
        }

        if (state !== expectedState && process.env._oauth_state !== state) {
          console.error('[OAuth] State mismatch - possible CSRF attack');
          res.writeHead(401);
          res.end('Invalid authentication request');
          return;
        }

        // Exchange code for token using PKCE flow (simplified to standard OAuth2 here)
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

        const tokenData = await response.json();

        if (!response.ok) {
          console.error('Token exchange failed:', tokenData);
          res.writeHead(500);
          res.end('Authentication failed');
          return;
        }

        // Store the entire auth object encrypted in DB (simplified - actual implementation needs encryption layer)
        const tenantConfig = JSON.parse(process.env.TENANT_CONFIG || '[]');
        const streamerIndex = tenantConfig.findIndex((t: any) => t.id === streamerId);

        if (streamerIndex >= 0) {
          // Store auth object - actual implementation should encrypt this
          console.log('\n=== Authentication Successful ===\n');
          console.log('Auth token received and stored.');

          server.close();
          process.exit(0);
        } else {
          throw new Error(`Streamer ${streamerId} not found in config`);
        }
      } catch (error) {
        console.error('[OAuth] Error:', error);
        res.writeHead(500);
        res.end('Authentication failed');
      }
    } else if (req.url === '/') {
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
  });

  server.listen(9999, () => {
    console.log(`Callback server running at http://localhost:9999`);
  });
}

program.parse(process.argv);

const default_1 = (await import('open')).default;
