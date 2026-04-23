#!/usr/bin/env tsx
import 'dotenv/config';

const colors = { green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', reset: '\x1b[0m' };
console.log(colors.green + '✅ Loaded .env\n' + colors.reset);

const url = process.env.DISCORD_ALERT_WEBHOOK_URL;
if (!url || !/^https:\/\/discord\.com\/api\/webhooks\/\d+/.test(url)) {
  console.error('\n❌ DISCORD_ALERT_WEBHOOK_URL not configured\n');
  process.exit(1);
}

console.log(
  `Webhook: ${url.split('/').slice(-2).join('/')}`.replace(/[a-zA-Z0-9_-]{4,}$/, '****') +
    '\n' +
    '='.repeat(65) +
    '\nDiscord Webhook Test Suite\n' +
    '='.repeat(65)
);
const enabled = process.env.DISCORD_ALERTS_ENABLED !== 'false';
console.log(
  enabled
    ? colors.green + '✅ Alerts enabled\n' + colors.reset
    : '\n⚠️  DISCORD_ALERTS_ENABLED=false - alerts disabled\n'
);

async function post(msg: string) {
  try {
    const response = await fetch(url!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: msg }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) throw new Error(`Status ${response.status}`);

    console.log(colors.green + '✅ Sent! ' + colors.reset);
  } catch (e: any) {
    console.error('\n❌ Failed:', e.message || String(e.code), '\n');
    return;
  }
}

await post('🧪 Discord Webhook Test - Basic Message');

async function embed() {
  try {
    const response = await fetch(url!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        embeds: [
          {
            title: '🧪 Embed Test',
            description: `Time:${new Date().toISOString()}`,
            color: 5763719,
            fields: [{ name: 'Status', value: '✅' }],
          },
        ],
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) throw new Error(`Status ${response.status}`);

    console.log(colors.green + '✅ Embed sent! ' + colors.reset + '\n');
  } catch (e) {
    console.error('\n❌ Failed\n');
  }
}

await embed();

console.log(
  '='.repeat(65) + '\n' + colors.cyan + 'All automated tests complete!' + colors.green + ' ✅' + colors.reset
);
