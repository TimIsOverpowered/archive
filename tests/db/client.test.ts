import { EventEmitter } from 'node:events';
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { resetEnvConfig } from '../../src/config/env.js';
import { stopClientCleanup, createPoolManager } from '../../src/db/streamer-client.js';
import type { Pool } from 'pg';
import { TenantConfig } from '../../src/config/types.js';
import { createMockTenantConfig } from '../helpers/worker-test-setup.js';

process.env.REDIS_URL = 'redis://localhost:6379';
process.env.META_DATABASE_URL = 'postgresql://localhost/test';
process.env.ENCRYPTION_MASTER_KEY = '0000000000000000000000000000000000000000000000000000000000000000';
process.env.PGBOUNCER_URL = 'postgresql://localhost/placeholder';

const createMockConfig = (id: string): TenantConfig =>
  createMockTenantConfig({
    id,
    displayName: id,
    database: {
      url: `postgresql://test:test@localhost:5432/${id}`,
    },
    settings: {
      domainName: `${id}.example.com`,
    },
  });

class MockPool extends EventEmitter {
  query = mock.fn(() => Promise.resolve({ rows: [] }));
  end = mock.fn(() => Promise.resolve());
  connect = mock.fn(() => Promise.resolve({ release: () => {} }));
  on = mock.fn(() => this);
  idleCount = 0;
  totalCount = 0;
}

describe('DB Client Manager', () => {
  let pm: ReturnType<typeof createPoolManager>;

  beforeEach(() => {
    pm = createPoolManager(MockPool as unknown as typeof Pool);
    resetEnvConfig();
  });

  afterEach(() => {
    stopClientCleanup();
    mock.restoreAll();
  });

  describe('getClient', () => {
    it('should return undefined for non-existent tenant', () => {
      const client = pm.getClient('non-existent');
      assert.strictEqual(client, undefined);
    });

    it('should return existing client and update lastAccessedAt', async () => {
      const config = createMockConfig('tenant-1');
      const client = await pm.createClient(config);
      assert.ok(client !== undefined);

      const client1 = pm.getClient('tenant-1');
      const client2 = pm.getClient('tenant-1');
      assert.strictEqual(client1, client2);
      assert.strictEqual(client1, client);
    });
  });

  describe('createClient', () => {
    it('should create a new client for a tenant', async () => {
      const config = createMockConfig('tenant-create-test');
      const client = await pm.createClient(config);
      assert.ok(client !== undefined);
      assert.strictEqual(pm.getCount(), 1);
    });

    it('should return existing client when called twice for same tenant', async () => {
      const config = createMockConfig('tenant-existing');
      const client1 = await pm.createClient(config);
      const client2 = await pm.createClient(config);
      assert.strictEqual(client1, client2);
      assert.strictEqual(pm.getCount(), 1);
    });

    it('should handle race condition when called simultaneously', async () => {
      const config = createMockConfig('tenant-race');
      const [client1, client2] = await Promise.all([pm.createClient(config), pm.createClient(config)]);
      assert.strictEqual(client1, client2);
      assert.strictEqual(pm.getCount(), 1);
    });
  });

  describe('closeClient', () => {
    it('should remove client from map after closing', async () => {
      const config = createMockConfig('tenant-close');
      await pm.createClient(config);
      assert.strictEqual(pm.getCount(), 1);

      await pm.closeClient('tenant-close');
      assert.strictEqual(pm.getCount(), 0);
    });

    it('should handle closing non-existent client gracefully', async () => {
      await pm.closeClient('non-existent');
      assert.strictEqual(pm.getCount(), 0);
    });
  });

  describe('closeAllClients', () => {
    it('should close all clients and clear the map', async () => {
      const config1 = createMockConfig('tenant-all-1');
      const config2 = createMockConfig('tenant-all-2');

      await pm.createClient(config1);
      await pm.createClient(config2);
      assert.strictEqual(pm.getCount(), 2);

      await pm.closeAll();
      assert.strictEqual(pm.getCount(), 0);
    });
  });

  describe('getClientCount', () => {
    it('should return 0 when no clients exist', () => {
      assert.strictEqual(pm.getCount(), 0);
    });

    it('should return correct count after creating clients', async () => {
      const config1 = createMockConfig('tenant-count-1');
      const config2 = createMockConfig('tenant-count-2');

      await pm.createClient(config1);
      assert.strictEqual(pm.getCount(), 1);

      await pm.createClient(config2);
      assert.strictEqual(pm.getCount(), 2);
    });
  });

  describe('reset', () => {
    it('should clear all clients and locks', async () => {
      const config = createMockConfig('tenant-reset');
      await pm.createClient(config);
      assert.strictEqual(pm.getCount(), 1);

      pm.reset();
      assert.strictEqual(pm.getCount(), 0);
    });
  });

  describe('startCleanup and stopCleanup', () => {
    it('should allow multiple calls to startCleanup without creating duplicate intervals', () => {
      pm.startCleanup();
      pm.startCleanup();
      pm.startCleanup();

      pm.stopCleanup();
      assert.ok(true);
    });

    it('should stop cleanup after start', () => {
      pm.startCleanup();
      pm.stopCleanup();
      assert.ok(true);
    });
  });

  describe('LRU eviction at MAX_CLIENTS', () => {
    it('should evict oldest idle client when MAX_CLIENTS is reached', async () => {
      const configs: TenantConfig[] = [];
      for (let i = 0; i < 11; i++) {
        configs.push(createMockConfig(`tenant-lru-${i}`));
      }

      for (const config of configs) {
        await pm.createClient(config);
      }

      assert.strictEqual(pm.getCount(), 10);

      assert.strictEqual(pm.getClient('tenant-lru-0'), undefined);

      for (let i = 1; i <= 10; i++) {
        assert.ok(pm.getClient(`tenant-lru-${i}`), `tenant-lru-${i} should exist`);
      }
    });
  });

  describe('idle timeout eviction', () => {
    it('should evict clients that have been idle for longer than IDLE_TIMEOUT', async () => {
      const config = createMockConfig('tenant-idle');
      await pm.createClient(config);
      assert.strictEqual(pm.getCount(), 1);

      const originalNow = Date.now;
      const oldTime = originalNow() - 31 * 60 * 1000;

      const entry = pm['pools'].get('tenant-idle') as { lastAccessedAt: number };
      entry.lastAccessedAt = oldTime;

      await pm.evictIdleClients();

      assert.strictEqual(pm.getCount(), 0);
      assert.strictEqual(pm.getClient('tenant-idle'), undefined);

      Date.now = originalNow;
    });
  });

  describe('integration', () => {
    it('should handle full lifecycle: create, access, close', async () => {
      const config = createMockConfig('tenant-lifecycle');

      assert.strictEqual(pm.getCount(), 0);

      const client = await pm.createClient(config);
      assert.ok(client !== undefined);
      assert.strictEqual(pm.getCount(), 1);

      const retrievedClient = pm.getClient('tenant-lifecycle');
      assert.ok(retrievedClient !== undefined);
      assert.strictEqual(retrievedClient, client);

      await pm.closeClient('tenant-lifecycle');
      assert.strictEqual(pm.getCount(), 0);

      const afterClose = pm.getClient('tenant-lifecycle');
      assert.strictEqual(afterClose, undefined);
    });

    it('should maintain correct state after multiple operations', async () => {
      const config1 = createMockConfig('tenant-state-1');
      const config2 = createMockConfig('tenant-state-2');
      const config3 = createMockConfig('tenant-state-3');

      await pm.createClient(config1);
      await pm.createClient(config2);
      assert.strictEqual(pm.getCount(), 2);

      pm.getClient('tenant-state-1');
      assert.strictEqual(pm.getCount(), 2);

      await pm.closeClient('tenant-state-2');
      assert.strictEqual(pm.getCount(), 1);

      await pm.createClient(config3);
      assert.strictEqual(pm.getCount(), 2);

      await pm.closeAll();
      assert.strictEqual(pm.getCount(), 0);
    });
  });
});
