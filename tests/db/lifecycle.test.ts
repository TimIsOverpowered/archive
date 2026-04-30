import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import {
  poolManager,
  withDbRetry,
  resetClientManager,
  createClient,
  ensureClient,
} from '../../src/db/streamer-client.js';
import { isConnectionError } from '../../src/db/utils/errors.js';
import type { TenantConfig } from '../../src/config/types.js';
import { createMockTenantConfig } from '../helpers/worker-test-setup.js';

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

const mockDb: any = {
  selectFrom: () => mockDb,
  insertInto: () => mockDb,
  update: () => mockDb,
  deleteFrom: () => mockDb,
  transaction: () => ({ execute: () => Promise.resolve({}) }),
  $pool: { end: () => Promise.resolve() },
  destroy: () => Promise.resolve(),
};

function nb() {
  return mockDb;
}

mockDb.select = nb;
mockDb.where = nb;
mockDb.orderBy = nb;
mockDb.limit = nb;
mockDb.first = () => Promise.resolve(null);
mockDb.values = nb;
mockDb.returning = nb;
mockDb.set = nb;
mockDb.execute = () => Promise.resolve({ affectedRows: 1 });
mockDb.raw = () => ({ execute: () => Promise.resolve([]) });

beforeEach(() => {
  resetClientManager();
  mock.method(poolManager, 'createClient', async () => mockDb);
  mock.method(poolManager, 'closeClient', async () => {});
});

afterEach(() => {
  mock.restoreAll();
  resetClientManager();
});

describe('DB Client Lifecycle Management', () => {
  describe('isConnectionError', () => {
    it('detects PostgreSQL error codes', () => {
      const errors = [
        { code: '57P01', message: 'terminating connection' },
        { code: '08006', message: 'connection violation' },
        { code: '08007', message: 'connection exception' },
        { code: '08001', message: 'connection failed' },
        { code: 'ECONNRESET', message: 'connection reset' },
        { code: 'ETIMEDOUT', message: 'timeout' },
        { code: 'EPIPE', message: 'broken pipe' },
      ];

      for (const error of errors) {
        const result = isConnectionError(error);
        assert.strictEqual(result, true, `Should detect code: ${error.code}`);
      }
    });

    it('detects connection errors from message', () => {
      const errorMessages = [
        'connection terminated unexpectedly',
        'socket connection closed',
        'connection lost to server',
        'ETIMEDOUT after 30000ms',
        'ECONNRESET',
        'The socket has been closed by the other end',
        'client network socket closed',
      ];

      for (const msg of errorMessages) {
        const error = new Error(msg);
        const result = isConnectionError(error);
        assert.strictEqual(result, true, `Should detect message: ${msg}`);
      }
    });

    it('returns false for non-connection errors', () => {
      const nonConnectionErrors = [
        new Error('Query timeout'),
        new Error('Constraint violation'),
        { code: '23505', message: 'unique violation' },
        'Some random string error',
      ];

      for (const error of nonConnectionErrors) {
        const result = isConnectionError(error);
        assert.strictEqual(result, false, `Should not detect as connection error: ${String(error)}`);
      }
    });
  });

  describe('ensureClient', () => {
    it('creates new client if none exists', async () => {
      const config = createMockConfig('test-tenant');
      const client = await ensureClient('test-tenant', config);
      assert.ok(client !== undefined);
    });

    it('returns existing valid client', async () => {
      const config = createMockConfig('test-tenant');
      const client1 = await ensureClient('test-tenant', config);
      const client2 = await ensureClient('test-tenant', config);
      assert.strictEqual(client1, client2);
    });

    it('returns client after timeout', async () => {
      const config = createMockConfig('test-tenant');
      await createClient(config);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const client = await ensureClient('test-tenant', config);
      assert.ok(client !== undefined);
    });
  });

  describe('withDbRetry', () => {
    it('executes operation successfully on first attempt', async () => {
      const config = createMockConfig('test-tenant');
      let callCount = 0;
      const result = await withDbRetry('test-tenant', config, async (_db) => {
        callCount++;
        return { success: true, callCount };
      });
      assert.strictEqual(callCount, 1);
      assert.strictEqual(result.success, true);
    });

    it('retries on connection error and succeeds', async () => {
      const config = createMockConfig('test-tenant');
      let attempt = 0;
      const result = await withDbRetry('test-tenant', config, async () => {
        attempt++;
        if (attempt < 2) {
          const error = new Error('connection closed');
          (error as { code?: string }).code = 'ECONNRESET';
          throw error;
        }
        return { success: true, attempts: attempt };
      });
      assert.strictEqual(attempt, 2);
      assert.strictEqual(result.success, true);
    });

    it('rethrows after max retries on connection error', async () => {
      const config = createMockConfig('test-tenant');
      await assert.rejects(
        withDbRetry('test-tenant', config, async () => {
          const error = new Error('connection lost');
          (error as { code?: string }).code = '08007';
          throw error;
        }),
        (err: Error) => {
          assert.ok(err.message.includes('connection lost') || err.message.includes('max retries'));
          return true;
        }
      );
    });

    it('rethrows immediately on non-connection error', async () => {
      const config = createMockConfig('test-tenant');
      let callCount = 0;
      await assert.rejects(
        withDbRetry('test-tenant', config, async () => {
          callCount++;
          throw new Error('Constraint violation');
        }),
        (err: Error) => {
          assert.strictEqual(err.message, 'Constraint violation');
          assert.strictEqual(callCount, 1);
          return true;
        }
      );
    });

    it('uses custom retry options', async () => {
      const config = createMockConfig('test-tenant');
      let attempt = 0;
      const result = await withDbRetry(
        'test-tenant',
        config,
        async () => {
          attempt++;
          if (attempt < 3) {
            const error = new Error('connection closed');
            (error as { code?: string }).code = 'ECONNRESET';
            throw error;
          }
          return { success: true, attempts: attempt };
        },
        { maxRetries: 3, retryDelayMs: 10 }
      );
      assert.strictEqual(attempt, 3);
      assert.strictEqual(result.success, true);
    });
  });
});
