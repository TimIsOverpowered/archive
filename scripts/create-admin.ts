#!/usr/bin/env node

import 'dotenv/config';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { initMetaClient, closeMetaClient } from '../src/db/meta-client.js';
import { extractErrorDetails } from '../src/utils/error.js';
import { findAdminByUsername, createAdmin } from '../src/services/admin.service.js';

const API_KEY_PREFIX = 'archive_';
const API_KEY_LENGTH = 64; // hex chars after prefix
const BCRYPT_COST = 10;

async function createAdminUser(username: string): Promise<void> {
  await initMetaClient();
  // Check if username already exists
  const existing = await findAdminByUsername(username);

  if (existing) {
    console.error(`Error: Admin user '${username}' already exists`);
    process.exit(1);
  }

  // Generate random API key
  const randomBytes = crypto.randomBytes(API_KEY_LENGTH / 2);
  const apiKey = `${API_KEY_PREFIX}${randomBytes.toString('hex')}`;

  // Hash the API key
  const apikeyHash = await bcrypt.hash(apiKey, BCRYPT_COST);

  // Insert into database
  await createAdmin({
    username,
    api_key_hash: apikeyHash,
  });

  // Print success message with API key (only shown once!)
  console.log('✓ Admin user created successfully!');
  console.log(`Username: ${username}`);
  console.log(`API Key: ${apiKey}`);
  console.log('\n⚠️ WARNING: Save this API key now - it cannot be retrieved later!');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: tsx create-admin.ts <username>');
    console.log('Example: tsx create-admin.ts admin');
    process.exit(1);
  }

  const [username] = args;

  try {
    await createAdminUser(username);
  } catch (error) {
    const details = extractErrorDetails(error);
    console.error('Error creating admin user:', details.message);
    process.exit(1);
  } finally {
    await closeMetaClient();
  }
}

main();
