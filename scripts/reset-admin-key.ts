#!/usr/bin/env node

import 'dotenv/config';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { initMetaClient, closeMetaClient } from '../src/db/meta-client.js';
import { extractErrorDetails } from '../src/utils/error.js';
import { findAdminByUsername, updateAdmin } from '../src/services/admin.service.js';

const API_KEY_PREFIX = 'archive_';
const API_KEY_LENGTH = 64; // hex chars after prefix
const BCRYPT_COST = 10;

async function resetAdminKey(username: string): Promise<void> {
  await initMetaClient();
  // Check if admin exists
  const admin = await findAdminByUsername(username);

  if (!admin) {
    console.error(`Error: Admin user '${username}' does not exist`);
    process.exit(1);
  }

  // Generate new random API key
  const randomBytes = crypto.randomBytes(API_KEY_LENGTH / 2);
  const newApiKey = `${API_KEY_PREFIX}${randomBytes.toString('hex')}`;

  // Hash the new API key
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
