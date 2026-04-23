import { EventEmitter } from 'node:events';
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { isConnectionError } from '../../src/db/utils/errors.js';
import { resetClientManager, createPoolManager } from '../../src/db/streamer-client.js';
import { resetEnvConfig } from '../../src/config/env.js';
import type { Pool } from 'pg';
import { TenantConfig } from '../../src/config/types.js';

process.env.REDIS_URL = 'redis://localhost:6379';
process.env.META_DATABASE_URL = 'postgresql://localhost/test';
process.env.ENCRYPTION_MASTER_KEY = '0000000000000000000000000000000000000000000000000000000000000000';
process.env.PGBOUNCER_URL = 'postgresql://localhost/placeholder';

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
  idleCount = 0;
  totalCount = 0;
}

describe('isConnectionError', () => {
  it('should return true for PostgreSQL connection lost error codes', () => {
    assert.strictEqual(isConnectionError({ code: '57P01' }), true, '57P01 (admin shutdown)');
    assert.strictEqual(isConnectionError({ code: '08006' }), true, '08006 (connection failure)');
    assert.strictEqual(isConnectionError({ code: '08007' }), true, '08007 (transaction resolution)');
    assert.strictEqual(isConnectionError({ code: '08001' }), true, '08001 (client cannot establish)');
  });

  it('should return true for Node.js connection error codes', () => {
    assert.strictEqual(isConnectionError({ code: 'ECONNRESET' }), true, 'ECONNRESET');
    assert.strictEqual(isConnectionError({ code: 'ETIMEDOUT' }), true, 'ETIMEDOUT');
    assert.strictEqual(isConnectionError({ code: 'EPIPE' }), true, 'EPIPE');
    assert.strictEqual(isConnectionError({ code: 'ECONNREFUSED' }), true, 'ECONNREFUSED');
  });

  it('should return true for connection-related message patterns', () => {
    assert.strictEqual(isConnectionError(new Error('connection terminated')), true);
    assert.strictEqual(isConnectionError(new Error('Connection lost')), true);
    assert.strictEqual(isConnectionError(new Error('connection closed by client')), true);
    assert.strictEqual(isConnectionError(new Error('socket connection closed')), true);
    assert.strictEqual(isConnectionError(new Error('network socket closed by peer')), true);
    assert.strictEqual(isConnectionError(new Error('client network socket closed')), true);
    assert.strictEqual(isConnectionError(new Error('ETIMEDOUT connecting')), true);
    assert.strictEqual(isConnectionError(new Error('ECONNRESET after write')), true);
    assert.strictEqual(isConnectionError(new Error('The socket has been closed')), true);
  });

  it('should return false for non-connection errors', () => {
    assert.strictEqual(isConnectionError({ code: '23505' }), false, 'Unique constraint violation');
    assert.strictEqual(isConnectionError({ code: '42P01' }), false, 'Undefined table');
    assert.strictEqual(isConnectionError({ code: '23503' }), false, 'Foreign key violation');
    assert.strictEqual(isConnectionError(new Error('syntax error at or near "SELECT"')), false);
    assert.strictEqual(isConnectionError(new Error('relation "users" does not exist')), false);
    assert.strictEqual(isConnectionError(new Error('permission denied for table users')), false);
    assert.strictEqual(isConnectionError(new Error('division by zero')), false);
    assert.strictEqual(isConnectionError(new Error('unknown error')), false);
  });

  it('should handle non-Error objects without code property', () => {
    assert.strictEqual(isConnectionError('string error'), false);
    assert.strictEqual(isConnectionError(42), false);
  });

  it('should handle Error objects with message patterns case-insensitively', () => {
    assert.strictEqual(isConnectionError(new Error('CONNECTION TERMINATED')), true);
    assert.strictEqual(isConnectionError(new Error('Socket Connection Closed')), true);
    assert.strictEqual(isConnectionError(new Error('Client Network Socket Closed')), true);
  });
});

describe('withDbRetry integration', () => {
  it('should succeed when operation does not throw', async () => {
    const pm = createPoolManager(MockPool as unknown as typeof Pool);
    const config = createMockConfig('tenant-integration-1');
    const mockDb = {
      selectFrom: () => ({ select: () => ({ where: () => ({ orderBy: () => ({ limit: () => ({ execute: async () => [] })})})})}),
      updateTable: () => ({ set: () => ({ where: () => ({ execute: async () => undefined })})}),
    };

    mock.method(pm, 'createClient', async () => mockDb);
    mock.method(pm, 'closeClient', async () => {});

    resetEnvConfig();

    const { withDbRetry } = await import('../../src/db/streamer-client.js');

    const result = await withDbRetry('tenant-integration-1', config, async (db) => {
      return { success: true, dbReceived: db !== null };
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.dbReceived, true);

    pm.reset();
    resetEnvConfig();
  });

  it('should pass the db client to the operation', async () => {
    const pm = createPoolManager(MockPool as unknown as typeof Pool);
    const config = createMockConfig('tenant-integration-2');
    let receivedDb: any = null;
    const mockDb = {
      selectFrom: () => ({ select: () => ({ where: () => ({ orderBy: () => ({ limit: () => ({ execute: async () => [] })})})})}),
      updateTable: () => ({ set: () => ({ where: () => ({ execute: async () => undefined })})}),
    };

    mock.method(pm, 'createClient', async () => mockDb);
    mock.method(pm, 'closeClient', async () => {});

    resetEnvConfig();

    const { withDbRetry } = await import('../../src/db/streamer-client.js');

    await withDbRetry('tenant-integration-2', config, async (db) => {
      receivedDb = db;
    });

    assert.ok(receivedDb !== null, 'Should receive db client');
    assert.ok('selectFrom' in receivedDb, 'Should have Kysely methods');

    pm.reset();
    resetEnvConfig();
  });

  it('should return operation result correctly', async () => {
    const pm = createPoolManager(MockPool as unknown as typeof Pool);
    const config = createMockConfig('tenant-integration-3');
    const expectedData = { id: 1, name: 'test', tags: ['a', 'b', 'c'] };
    const mockDb = {
      selectFrom: () => ({ select: () => ({ where: () => ({ orderBy: () => ({ limit: () => ({ execute: async () => [] })})})})}),
      updateTable: () => ({ set: () => ({ where: () => ({ execute: async () => undefined })})}),
    };

    mock.method(pm, 'createClient', async () => mockDb);
    mock.method(pm, 'closeClient', async () => {});

    resetEnvConfig();

    const { withDbRetry } = await import('../../src/db/streamer-client.js');

    const result = await withDbRetry('tenant-integration-3', config, async () => expectedData);

    assert.deepStrictEqual(result, expectedData);

    pm.reset();
    resetEnvConfig();
  });

  it('should throw immediately on non-connection errors', async () => {
    const pm = createPoolManager(MockPool as unknown as typeof Pool);
    const config = createMockConfig('tenant-integration-4');
    const mockDb = {
      selectFrom: () => ({ select: () => ({ where: () => ({ orderBy: () => ({ limit: () => ({ execute: async () => [] })})})})}),
      updateTable: () => ({ set: () => ({ where: () => ({ execute: async () => undefined })})}),
    };

    mock.method(pm, 'createClient', async () => mockDb);
    mock.method(pm, 'closeClient', async () => {});

    resetEnvConfig();

    const { withDbRetry } = await import('../../src/db/streamer-client.js');

    let errorThrown: Error | null = null;
    try {
      await withDbRetry('tenant-integration-4', config, async () => {
        throw { code: '23505', message: 'unique violation' };
      });
    } catch (error) {
      errorThrown = error as Error;
    }

    assert.ok(errorThrown, 'Should throw immediately');
    assert.strictEqual((errorThrown as any).code, '23505');

    pm.reset();
    resetEnvConfig();
  });

  it('should detect connection errors from error objects', () => {
    assert.strictEqual(isConnectionError({ code: '08006' }), true);
    assert.strictEqual(isConnectionError({ code: 'ECONNRESET' }), true);
    assert.strictEqual(isConnectionError(new Error('connection terminated')), true);
    assert.strictEqual(isConnectionError(new Error('socket connection closed')), true);
    assert.strictEqual(isConnectionError({ code: '23505' }), false);
    assert.strictEqual(isConnectionError(new Error('syntax error')), false);
    assert.strictEqual(isConnectionError('string'), false);
  });
});
