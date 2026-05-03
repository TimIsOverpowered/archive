#!/usr/bin/env node

import 'dotenv/config';
import bcrypt from 'bcrypt';
import { initMetaClient, closeMetaClient } from '../src/db/meta-client.js';
import { findAdminByUsername, updateAdmin, generateApiKey } from '../src/services/admin.service.js';
import { extractErrorDetails } from '../src/utils/error.js';

const BCRYPT_COST = 10;

async function resetAdminKey(username: string): Promise<void> {
  await initMetaClient();
  const admin = await findAdminByUsername(username);

  if (!admin) {
    console.error(`Error: Admin user '${username}' does not exist`);
    process.exit(1);
  }

  const newApiKey = generateApiKey(username);
  const newApiKeyHash = await bcrypt.hash(newApiKey, BCRYPT_COST);

  // Update database
  await updateAdmin(username, {
    api_key_hash: newApiKeyHash,
  });

  // Print success message with new API key (only shown once!)
  console.log('✓ API key reset successfully!');
  console.log(`Username: ${username}`);
  console.log(`New API Key: ${newApiKey}`);
  console.log('\n⚠️ WARNING: Save this new API key now - the old one is revoked!');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: tsx reset-admin-key.ts <username>');
    console.log('Example: tsx reset-admin-key.ts admin');
    process.exit(1);
  }

  const [username] = args;
  if (!username) {
    console.error('Usage: npm run reset-admin-key <username>');
    process.exit(1);
  }

  try {
    await resetAdminKey(username);
  } catch (error) {
    const details = extractErrorDetails(error);
    console.error('Error resetting API key:', details.message);
    process.exit(1);
  } finally {
    await closeMetaClient();
  }
}

main();
