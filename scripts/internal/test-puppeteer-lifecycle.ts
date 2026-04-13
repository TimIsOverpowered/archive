#!/usr/bin/env node
/**
 * Puppeteer Lifecycle Test Script
 *
 * Verifies that:
 * 1. Browser initializes correctly
 * 2. releaseBrowser() closes gracefully
 * 3. No zombie Chrome processes remain after shutdown
 *
 * Usage: npx tsx scripts/internal/test-puppeteer-lifecycle.ts
 */

import 'dotenv/config';
import { getBrowser, releaseBrowser, getChromePid } from '../../src/utils/puppeteer-manager.js';
import { logger } from '../../src/utils/logger.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const log = logger.child({ module: 'test-puppeteer-lifecycle' });
const execAsync = promisify(exec);

async function getChromeProcesses(): Promise<string[]> {
  try {
    const { stdout } = await execAsync('ps aux | grep -i chrome | grep -v grep');
    return stdout.trim() ? stdout.trim().split('\n') : [];
  } catch {
    return [];
  }
}

async function testGracefulShutdown(): Promise<void> {
  log.info('=== Test 1: Graceful Shutdown ===');

  const beforeProcesses = await getChromeProcesses();
  log.info({ count: beforeProcesses.length }, 'Chrome processes before test');

  log.info('Initializing browser...');
  const { browser } = await getBrowser();
  const pid = getChromePid();
  log.info({ pid, connected: browser.connected }, 'Browser initialized');

  log.info('Releasing browser...');
  await releaseBrowser();
  log.info('Browser released');

  await new Promise((resolve) => setTimeout(resolve, 1000));

  const afterProcesses = await getChromeProcesses();
  log.info({ count: afterProcesses.length }, 'Chrome processes after test');

  if (afterProcesses.length > beforeProcesses.length) {
    log.warn('WARNING: Zombie Chrome processes detected!');
    afterProcesses.forEach((p) => log.warn(p));
  } else {
    log.info('✓ No zombie processes detected');
  }
}

async function testTimeoutFallback(): Promise<void> {
  log.info('=== Test 2: Timeout Fallback (Simulated) ===');
  log.info('This test would require modifying releaseBrowser() to simulate a hang');
  log.info('For now, manual testing recommended:');
  log.info('1. Set PUPPETEER_SHUTDOWN_TIMEOUT_MS=1000');
  log.info('2. Modify releaseBrowser() to await new Promise() before close()');
  log.info('3. Verify SIGKILL is triggered after timeout');
}

async function main(): Promise<void> {
  log.info('Starting Puppeteer Lifecycle Tests');
  log.info(`PUPPETEER_SHUTDOWN_TIMEOUT_MS: ${process.env.PUPPETEER_SHUTDOWN_TIMEOUT_MS || '5000 (default)'}`);

  try {
    await testGracefulShutdown();
    await testTimeoutFallback();

    log.info('=== All Tests Completed ===');
    process.exit(0);
  } catch (error) {
    log.error({ error: error instanceof Error ? error.message : String(error) }, 'Test failed');
    process.exit(1);
  }
}

main();
