import { mock } from 'node:test';
import { RedisService } from '../../src/utils/redis-service.js';
import { poolManager, resetClientManager } from '../../src/db/streamer-client.js';
import { resetEnvConfig } from '../../src/config/env.js';

const VALID_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

export function setupBaseEnv(vodPath?: string): void {
  Object.keys(process.env).forEach((key) => delete process.env[key]);
  process.env.REDIS_URL = 'redis://localhost';
  process.env.META_DATABASE_URL = 'postgresql://meta';
  process.env.PGBOUNCER_URL = 'postgresql://bouncer';
  process.env.ENCRYPTION_MASTER_KEY = VALID_KEY;
  process.env.NODE_ENV = 'test';
  if (vodPath !== undefined) {
    process.env.VOD_PATH = vodPath;
  }
}

export interface MockDbOptions {
  withInsertInto?: boolean;
}

export function buildMockDb(opts: MockDbOptions = {}): any {
  const selectResult = {
    where: () => ({
      orderBy: () => ({
        limit: () => ({
          execute: async () => [],
        }),
      }),
    }),
  };

  const insertIntoResult = {
    values: () => ({
      onConflict: () => ({
        doUpdateSet: () => ({
          execute: async () => undefined,
        }),
      }),
    }),
  };

  const selectFn = () => {
    const result: any = {
      ...selectResult,
    };
    if (opts.withInsertInto) {
      result.insertInto = () => insertIntoResult;
    }
    return result;
  };

  return {
    selectFrom: () => ({ select: selectFn }),
    updateTable: () => ({
      set: () => ({
        where: () => ({
          execute: async () => undefined,
        }),
      }),
    }),
  };
}

export function buildMockClient(): any {
  return {
    get: async () => null,
    publish: async () => {},
  };
}

export interface WorkerMockState {
  mockDb: any;
  mockClient: any;
  originalEnv: NodeJS.ProcessEnv;
}

export function setupWorkerMocks(): WorkerMockState {
  const originalEnv = { ...process.env };

  const mockDb = buildMockDb();
  const mockClient = buildMockClient();

  (RedisService as any)._instance = {
    getClient: () => mockClient,
  };

  resetEnvConfig();
  resetClientManager();
  mock.method(poolManager, 'createClient', async () => mockDb);
  mock.method(poolManager, 'closeClient', async () => {});

  return { mockDb, mockClient, originalEnv };
}

export function setupWorkerMocksWithDb(mockDb: any): WorkerMockState {
  const originalEnv = { ...process.env };

  const mockClient = buildMockClient();

  (RedisService as any)._instance = {
    getClient: () => mockClient,
  };

  resetEnvConfig();
  resetClientManager();
  mock.method(poolManager, 'createClient', async () => mockDb);
  mock.method(poolManager, 'closeClient', async () => {});

  return { mockDb, mockClient, originalEnv };
}

export function teardownWorkerMocks(state: WorkerMockState): void {
  Object.assign(process.env, state.originalEnv);
  (RedisService as any)._instance = null;
  mock.restoreAll();
  resetClientManager();
  resetEnvConfig();
}
