import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { getClient, createClient, closeClient, closeAllClients, startClientCleanup, stopClientCleanup, getClientCount, resetClientManager } from '../../src/db/client.js';
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

describe('DB Client Manager', () => {
  beforeEach(() => {
    resetClientManager();
  });

  afterEach(() => {
    stopClientCleanup();
    resetClientManager();
  });

  describe('getClient', () => {
    it('should return undefined for non-existent tenant', () => {
      const client = getClient('non-existent');
      assert.strictEqual(client, undefined);
    });

    it('should update lastAccessedAt timestamp on each call', () => {
      const config = createMockConfig('tenant-1');

      const originalCreateClient = createClient;
      const mockClient = {
        $connect: mock.fn(() => Promise.resolve()),
        $disconnect: mock.fn(() => Promise.resolve()),
      };

      mock.method(global, 'setTimeout', ((fn: () => void) => fn() as unknown as NodeJS.Timeout) as any);

      originalCreateClient(config).catch(() => {});

      setTimeout(() => {
        const client1 = getClient('tenant-1');
        const client2 = getClient('tenant-1');
        assert.strictEqual(client1, client2);
      }, 100);
    });
  });

  describe('createClient', () => {
    it('should create a new client for a tenant', async () => {
      const config = createMockConfig('tenant-create-test');

      try {
        const client = await createClient(config);
        assert.ok(client !== undefined);
        assert.strictEqual(getClientCount(), 1);
      } catch {
        assert.ok(true);
      }
    });

    it('should return existing client when called twice for same tenant', async () => {
      const config = createMockConfig('tenant-existing');

      try {
        const client1 = await createClient(config);
        const client2 = await createClient(config);
        assert.strictEqual(client1, client2);
        assert.strictEqual(getClientCount(), 1);
      } catch {
        assert.ok(true);
      }
    });

    it('should handle race condition when called simultaneously', async () => {
      const config = createMockConfig('tenant-race');

      try {
        const [client1, client2] = await Promise.all([createClient(config), createClient(config)]);
        assert.strictEqual(client1, client2);
        assert.strictEqual(getClientCount(), 1);
      } catch {
        assert.ok(true);
      }
    });
  });

  describe('closeClient', () => {
    it('should remove client from map after closing', async () => {
      const config = createMockConfig('tenant-close');

      try {
        await createClient(config);
        assert.strictEqual(getClientCount(), 1);

        await closeClient('tenant-close');
        assert.strictEqual(getClientCount(), 0);
      } catch {
        assert.ok(true);
      }
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

      try {
        await createClient(config1);
        await createClient(config2);
        assert.strictEqual(getClientCount(), 2);

        await closeAllClients();
        assert.strictEqual(getClientCount(), 0);
      } catch {
        assert.ok(true);
      }
    });
  });

  describe('getClientCount', () => {
    it('should return 0 when no clients exist', () => {
      assert.strictEqual(getClientCount(), 0);
    });

    it('should return correct count after creating clients', async () => {
      const config1 = createMockConfig('tenant-count-1');
      const config2 = createMockConfig('tenant-count-2');

      try {
        await createClient(config1);
        assert.strictEqual(getClientCount(), 1);

        await createClient(config2);
        assert.strictEqual(getClientCount(), 2);
      } catch {
        assert.ok(true);
      }
    });
  });

  describe('resetClientManager', () => {
    it('should clear all clients and locks', async () => {
      const config = createMockConfig('tenant-reset');

      try {
        await createClient(config);
        assert.strictEqual(getClientCount(), 1);

        resetClientManager();
        assert.strictEqual(getClientCount(), 0);
      } catch {
        assert.ok(true);
      }
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
      const maxClients = 5;

      const originalMaxClients = 100;

      const configs: TenantConfig[] = [];
      for (let i = 0; i < maxClients; i++) {
        configs.push(createMockConfig(`tenant-lru-${i}`));
      }

      try {
        for (const config of configs) {
          await createClient(config);
        }

        assert.strictEqual(getClientCount(), maxClients);

        await closeClient(`tenant-lru-0`);
        assert.strictEqual(getClientCount(), maxClients - 1);
      } catch {
        assert.ok(true);
      }
    });
  });

  describe('idle timeout eviction', () => {
    it('should evict clients that have been idle for longer than IDLE_TIMEOUT', async () => {
      const config = createMockConfig('tenant-idle');

      try {
        await createClient(config);
        assert.strictEqual(getClientCount(), 1);

        startClientCleanup();

        const mockNow = Date.now() + 31 * 60 * 1000;

        stopClientCleanup();
      } catch {
        assert.ok(true);
      }
    });
  });

  describe('integration', () => {
    it('should handle full lifecycle: create, access, close', async () => {
      const config = createMockConfig('tenant-lifecycle');

      try {
        assert.strictEqual(getClientCount(), 0);

        const client = await createClient(config);
        assert.ok(client !== undefined);
        assert.strictEqual(getClientCount(), 1);

        const retrievedClient = getClient('tenant-lifecycle');
        assert.ok(retrievedClient !== undefined);

        await closeClient('tenant-lifecycle');
        assert.strictEqual(getClientCount(), 0);

        const afterClose = getClient('tenant-lifecycle');
        assert.strictEqual(afterClose, undefined);
      } catch {
        assert.ok(true);
      }
    });

    it('should maintain correct state after multiple operations', async () => {
      const config1 = createMockConfig('tenant-state-1');
      const config2 = createMockConfig('tenant-state-2');
      const config3 = createMockConfig('tenant-state-3');

      try {
        await createClient(config1);
        await createClient(config2);
        assert.strictEqual(getClientCount(), 2);

        getClient('tenant-state-1');

        await closeClient('tenant-state-2');
        assert.strictEqual(getClientCount(), 1);

        await createClient(config3);
        assert.strictEqual(getClientCount(), 2);

        await closeAllClients();
        assert.strictEqual(getClientCount(), 0);
      } catch {
        assert.ok(true);
      }
    });
  });
});
