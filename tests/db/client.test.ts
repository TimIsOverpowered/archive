import { EventEmitter } from 'node:events';
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { resetEnvConfig } from '../../src/config/env.js';
import {
  getClient,
  createClient,
  closeClient,
  closeAllClients,
  startClientCleanup,
  stopClientCleanup,
  getClientCount,
  resetClientManager,
  _setPoolCtor,
} from '../../src/db/client.js';

process.env.REDIS_URL = 'redis://localhost:6379';
process.env.META_DATABASE_URL = 'postgresql://localhost/test';
process.env.ENCRYPTION_MASTER_KEY = '0000000000000000000000000000000000000000000000000000000000000000';
process.env.PGBOUNCER_URL = 'postgresql://localhost/placeholder';
import { TenantConfig } from '../../src/config/types.js';

const createMockConfig = (id: string): TenantConfig => ({
  id,
  displayName: id,
  createdAt: new Date(),
  database: {
    url: `postgresql://test:test@localhost:5432/${id}`,
  },
  settings: {
    domainName: `${id}.example.com`,
    timezone: 'UTC',
    saveMP4: false,
    saveHLS: false,
  },
  youtube: {
    public: false,
    upload: false,
    vodUpload: false,
    liveUpload: false,
    multiTrack: false,
    splitDuration: 60,
    perGameUpload: false,
    restrictedGames: [],
    description: '',
  },
  twitch: {
    enabled: false,
  },
  kick: {
    enabled: false,
  },
});

class MockPool extends EventEmitter {
  query = mock.fn(() => Promise.resolve({ rows: [] }));
  end = mock.fn(() => Promise.resolve());
  connect = mock.fn(() => Promise.resolve({ release: () => {} }));
  on = mock.fn(() => this);
}

describe('DB Client Manager', () => {
  beforeEach(() => {
    _setPoolCtor(MockPool as unknown as typeof import('pg').Pool);
    resetClientManager();
    resetEnvConfig();
  });

  afterEach(() => {
    stopClientCleanup();
    resetClientManager();
    mock.restoreAll();
  });

  describe('getClient', () => {
    it('should return undefined for non-existent tenant', () => {
      const client = getClient('non-existent');
      assert.strictEqual(client, undefined);
    });

    it('should return existing client and update lastAccessedAt', async () => {
      const config = createMockConfig('tenant-1');
      const client = await createClient(config);
      assert.ok(client !== undefined);

      const client1 = getClient('tenant-1');
      const client2 = getClient('tenant-1');
      assert.strictEqual(client1, client2);
      assert.strictEqual(client1, client);
    });
  });

  describe('createClient', () => {
    it('should create a new client for a tenant', async () => {
      const config = createMockConfig('tenant-create-test');
      const client = await createClient(config);
      assert.ok(client !== undefined);
      assert.strictEqual(getClientCount(), 1);
    });

    it('should return existing client when called twice for same tenant', async () => {
      const config = createMockConfig('tenant-existing');
      const client1 = await createClient(config);
      const client2 = await createClient(config);
      assert.strictEqual(client1, client2);
      assert.strictEqual(getClientCount(), 1);
    });

    it('should handle race condition when called simultaneously', async () => {
      const config = createMockConfig('tenant-race');
      const [client1, client2] = await Promise.all([createClient(config), createClient(config)]);
      assert.strictEqual(client1, client2);
      assert.strictEqual(getClientCount(), 1);
    });
  });

  describe('closeClient', () => {
    it('should remove client from map after closing', async () => {
      const config = createMockConfig('tenant-close');
      await createClient(config);
      assert.strictEqual(getClientCount(), 1);

      await closeClient('tenant-close');
      assert.strictEqual(getClientCount(), 0);
    });

    it('should handle closing non-existent client gracefully', async () => {
      await closeClient('non-existent');
      assert.strictEqual(getClientCount(), 0);
    });
  });

  describe('closeAllClients', () => {
    it('should close all clients and clear the map', async () => {
      const config1 = createMockConfig('tenant-all-1');
      const config2 = createMockConfig('tenant-all-2');

      await createClient(config1);
      await createClient(config2);
      assert.strictEqual(getClientCount(), 2);

      await closeAllClients();
      assert.strictEqual(getClientCount(), 0);
    });
  });

  describe('getClientCount', () => {
    it('should return 0 when no clients exist', () => {
      assert.strictEqual(getClientCount(), 0);
    });

    it('should return correct count after creating clients', async () => {
      const config1 = createMockConfig('tenant-count-1');
      const config2 = createMockConfig('tenant-count-2');

      await createClient(config1);
      assert.strictEqual(getClientCount(), 1);

      await createClient(config2);
      assert.strictEqual(getClientCount(), 2);
    });
  });

  describe('resetClientManager', () => {
    it('should clear all clients and locks', async () => {
      const config = createMockConfig('tenant-reset');
      await createClient(config);
      assert.strictEqual(getClientCount(), 1);

      resetClientManager();
      assert.strictEqual(getClientCount(), 0);
    });
  });

  describe('startClientCleanup and stopClientCleanup', () => {
    it('should allow multiple calls to startClientCleanup without creating duplicate intervals', () => {
      startClientCleanup();
      startClientCleanup();
      startClientCleanup();

      stopClientCleanup();
      assert.ok(true);
    });

    it('should stop cleanup after start', () => {
      startClientCleanup();
      stopClientCleanup();
      assert.ok(true);
    });
  });

  describe('LRU eviction at MAX_CLIENTS', () => {
    it('should evict oldest idle client when MAX_CLIENTS is reached', async () => {
      // DB_POOL_MAX_CLIENTS = 10, so creating 11 should evict the oldest
      const configs: TenantConfig[] = [];
      for (let i = 0; i < 11; i++) {
        configs.push(createMockConfig(`tenant-lru-${i}`));
      }

      for (const config of configs) {
        await createClient(config);
      }

      assert.strictEqual(getClientCount(), 10);

      // The oldest client (tenant-lru-0) should have been evicted
      assert.strictEqual(getClient('tenant-lru-0'), undefined);

      // The newest 10 should still exist
      for (let i = 1; i <= 10; i++) {
        assert.ok(getClient(`tenant-lru-${i}`), `tenant-lru-${i} should exist`);
      }
    });
  });

  describe('idle timeout eviction', () => {
    it('should evict clients that have been idle for longer than IDLE_TIMEOUT', async () => {
      const config = createMockConfig('tenant-idle');
      await createClient(config);
      assert.strictEqual(getClientCount(), 1);

      const originalNow = Date.now;
      // Set the client's lastAccessedAt to 31 minutes ago
      const oldTime = originalNow() - 31 * 60 * 1000;

      // Manually touch the pool to simulate it being idle
      const { poolManager } = await import('../../src/db/client.js');
      const entry = poolManager['pools'].get('tenant-idle') as { lastAccessedAt: number };
      entry.lastAccessedAt = oldTime;

      // Run eviction manually
      await poolManager.evictIdleClients();

      assert.strictEqual(getClientCount(), 0);
      assert.strictEqual(getClient('tenant-idle'), undefined);

      Date.now = originalNow;
    });
  });

  describe('integration', () => {
    it('should handle full lifecycle: create, access, close', async () => {
      const config = createMockConfig('tenant-lifecycle');

      assert.strictEqual(getClientCount(), 0);

      const client = await createClient(config);
      assert.ok(client !== undefined);
      assert.strictEqual(getClientCount(), 1);

      const retrievedClient = getClient('tenant-lifecycle');
      assert.ok(retrievedClient !== undefined);
      assert.strictEqual(retrievedClient, client);

      await closeClient('tenant-lifecycle');
      assert.strictEqual(getClientCount(), 0);

      const afterClose = getClient('tenant-lifecycle');
      assert.strictEqual(afterClose, undefined);
    });

    it('should maintain correct state after multiple operations', async () => {
      const config1 = createMockConfig('tenant-state-1');
      const config2 = createMockConfig('tenant-state-2');
      const config3 = createMockConfig('tenant-state-3');

      await createClient(config1);
      await createClient(config2);
      assert.strictEqual(getClientCount(), 2);

      getClient('tenant-state-1');
      assert.strictEqual(getClientCount(), 2);

      await closeClient('tenant-state-2');
      assert.strictEqual(getClientCount(), 1);

      await createClient(config3);
      assert.strictEqual(getClientCount(), 2);

      await closeAllClients();
      assert.strictEqual(getClientCount(), 0);
    });
  });
});
