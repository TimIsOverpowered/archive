import { program } from 'commander';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import crypto from 'crypto';
import http from 'http';
import open from 'open';
import readline from 'readline';

// Load environment variables based on NODE_ENV
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
dotenv.config({ path: `.${envFile}` });

program.name('auth-youtube').description('YouTube OAuth authentication CLI tool (headless-friendly)').version('1.0.0');

interface Tenant {
  id: string;
  displayName: string;
  youtube?: any;
}

async function getTenant(streamerIdOrName: string): Promise<Tenant | null> {
  try {
    if (!process.env.META_DATABASE_URL) {
      console.error('META_DATABASE_URL is required for tenant lookup');
      return null;
    }

    const { PrismaClient } = await import('../../prisma/generated/meta');
    const prismaMeta = new PrismaClient();

    try {
      await prismaMeta.$connect();

      let tenant: Tenant | null = null;

      if (streamerIdOrName.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
        tenant = await prismaMeta.tenant.findUnique({
          where: { id: streamerIdOrName },
        });
      } else {
        const config = JSON.parse(process.env.TENANT_CONFIG || '[]');
        const configTenant = config.find((t: any) => t.id === streamerIdOrName);

        if (configTenant?.databaseUrl) {
          tenant = await prismaMeta.tenant.findUnique({
            where: { id: configTenant.databaseUrl.split('/').pop() || configTenant.id },
          });
        } else {
          const matchingConfig = config.find((t: any) => t.id === streamerIdOrName);

          if (matchingConfig?.database.url) {
            tenant = await prismaMeta.tenant.findUnique({
              where: { databaseUrl: matchingConfig.database.url },
            });
          } else {
            throw new Error('Could not determine tenant ID from config');
          }
        }

        if (!tenant) {
          const allTenants = await prismaMeta.tenant.findMany();
          const foundByName = allTenants.find((t: any) => t.displayName === streamerIdOrName);
          if (foundByName) tenant = foundByName;
        }
      }

      if (!tenant) {
        console.error(`Tenant not found: ${streamerIdOrName}`);
        return null;
      }

      await prismaMeta.$disconnect();
      return tenant as Tenant;
    } catch (error) {
      await prismaMeta.$disconnect().catch(() => {});
      throw error;
    }
  } catch (error: any) {
    console.error('Error getting tenant:', error.message || error);
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

  console.log('\n=== YouTube OAuth Authentication ===\n');

  const mode = process.argv.includes('--headless') ? 'Headless' : 'Browser';
  console.log(`Mode: ${mode}`);
  console.log(`Tenant ID: ${tenantId}\n`);

  if (process.argv.includes('--open')) {
    await open(authUrl.toString());
    startCallbackServer(tenantId, state);
  } else {
    console.log('Open this URL in your browser:\n');
    console.log(`${authUrl.toString()}\n`);
    console.log('After authorizing, you will be redirected to http://localhost:9999/callback\n');

    if (process.argv.includes('--headless')) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const userCode = await new Promise<string>((resolve) => {
        console.log('Paste the full redirect URL here (or press Enter to start callback server):');

        rl.question('', (answer) => {
          if (answer.trim()) {
            resolve(answer);
          } else {
            resolve('');
          }
          rl.close();
        });
      });

      if (userCode && userCode.startsWith('http')) {
        await completeOAuth(tenantId, state, userCode);
      } else {
        startCallbackServer(tenantId, state);
      }
    } else {
      startCallbackServer(tenantId, state);
    }
  }
}

function startCallbackServer(streamerId: string, expectedState: string): void {
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/callback')) {
      try {
        const urlObj = new URL(req.url, 'http://localhost:9999');
        const code = urlObj.searchParams.get('code');

        await completeOAuth(streamerId, expectedState, urlObj.href);
      } catch (error) {
        console.error('[OAuth] Error:', error);
        res.writeHead(500);
        res.end('Authentication failed. Check the terminal for details.');
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

async function completeOAuth(streamerId: string, expectedState: string, urlOrCode: string): Promise<void> {
  let code = '';

  if (urlOrCode.startsWith('http')) {
    const urlObj = new URL(urlOrCode);
    const stateParam = urlObj.searchParams.get('state');
    const receivedCode = urlObj.searchParams.get('code');

    console.log(`\nReceived callback with state: ${stateParam}`);
    console.log(`Expected state: ${expectedState}`);

    if (receivedCode) {
      code = receivedCode;
    } else {
      throw new Error('No authorization code in URL');
    }

    if (!code || !urlOrCode.includes(code)) {
      const allParams = urlObj.search
        .slice(1)
        .split('&')
        .reduce(
          (acc, pair) => {
            const [key, value] = pair.split('=');
            acc[decodeURIComponent(key)] = decodeURIComponent(value);
            return acc;
          },
          {} as Record<string, string>
        );

      if (allParams.code && allParams.state === expectedState) {
        code = allParams.code!;
      } else if (!urlOrCode.includes('error=')) {
        throw new Error(`Invalid state parameter. Expected: ${expectedState}, Received: ${stateParam}`);
      } else {
        console.error('\n=== OAuth Error ===');
        Object.entries(allParams).forEach(([key, value]) => {
          if (key !== 'redirect_uri') {
            console.log(`${key}: ${value}\n`);
          }
        });
        process.exit(1);
      }
    } else {
      throw new Error('Authorization code not found in URL');
    }

    server.close();
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

    const tokenData = await response.json();

    if (!response.ok) {
      console.error('Token exchange failed:', tokenData);
      process.exit(1);
    }

    const authObject = {
      type: 'auth' as const,
      ...tokenData,
    };

    console.log('\n=== Authentication Successful ===\n');
    console.log(`Stream ID: ${streamerId}`);
    console.log('Token received. Storing encrypted authentication object in database...\n');

    await storeAuthObject(streamerId, authObject);

    server.close();
    process.exit(0);
  } catch (error) {
    console.error('[OAuth] Token exchange error:', error);
    throw error;
  }
}

async function storeAuthObject(tenantId: string, authObject: any): Promise<void> {
  if (!process.env.META_DATABASE_URL) {
    throw new Error('META_DATABASE_URL is required for storing auth object');
  }

  const { PrismaClient } = await import('../../prisma/generated/meta');
  const prismaMeta = new PrismaClient();

  try {
    await prismaMeta.$connect();

    let encryptedAuth: string;
    if (process.env.ENCRYPTION_MASTER_KEY) {
      const { encryptObject } = await import('../src/utils/encryption.js');
      encryptedAuth = encryptObject(authObject);
      console.log('Using encryption for auth object storage.');
    } else {
      encryptedAuth = JSON.stringify(authObject);
      console.warn('WARNING: Storing auth object unencrypted (no ENCRYPTION_MASTER_KEY)');
    }

    await prismaMeta.tenant.update({
      where: { id: tenantId },
      data: { youtube: encryptedAuth },
    });

    console.log('\n=== Auth Object Stored Successfully ===\n');
  } catch (error: any) {
    if ((error as any).code === 'P2025') {
      throw new Error(`Tenant not found in database: ${tenantId}`);
    }
    throw error;
  } finally {
    await prismaMeta.$disconnect();
  }
}

program
  .argument('<streamer_id>', 'Streamer ID or display name to authenticate')
  .option('--open', 'Automatically open browser for OAuth flow')
  .option('--headless', 'Run in headless mode (paste URL manually)')
  .action(async (streamerId: string, options) => {
    const tenant = await getTenant(streamerId);

    if (!tenant) {
      console.error('Failed to load tenant. Please verify the streamer ID or display name.');
      process.exit(1);
    }

    startOAuthFlow(tenant.id);
  });

program.parse(process.argv);
