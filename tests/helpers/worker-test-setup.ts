import { mock } from 'node:test';
import { resetEnvConfig } from '../../src/config/env.js';
import type {
  TenantConfig,
  TwitchConfig,
  YouTubeConfig,
  KickConfig,
  TenantSettings,
  DatabaseConfig,
} from '../../src/config/types.js';
import { poolManager, resetClientManager } from '../../src/db/streamer-client.js';
import { RedisService } from '../../src/utils/redis-service.js';

export interface MockTenantConfigOverrides {
  id?: string;
  displayName?: string;
  createdAt?: Date;
  twitch?: Partial<TwitchConfig>;
  youtube?: Partial<YouTubeConfig>;
  kick?: Partial<KickConfig>;
  database?: Partial<DatabaseConfig>;
  settings?: Partial<TenantSettings>;
}

export function createMockTenantConfig(overrides: MockTenantConfigOverrides = {}): TenantConfig {
  return {
    id: overrides.id ?? 'test-tenant',
    displayName: overrides.displayName ?? 'Test Tenant',
    createdAt: overrides.createdAt ?? new Date(),
    twitch: {
      enabled: false,
      mainPlatform: false,
      username: undefined,
      id: undefined,
      ...(overrides.twitch ?? {}),
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
      auth: undefined,
      ...(overrides.youtube ?? {}),
    },
    kick: {
      enabled: false,
      mainPlatform: false,
      id: undefined,
      username: undefined,
      ...(overrides.kick ?? {}),
    },
    database: {
      url: 'postgresql://test:test@localhost:5432/test',
      ...(overrides.database ?? {}),
    },
    settings: {
      domainName: overrides.settings?.domainName ?? 'test.example.com',
      timezone: overrides.settings?.timezone ?? 'UTC',
      saveMP4: overrides.settings?.saveMP4 ?? false,
      saveHLS: overrides.settings?.saveHLS ?? false,
      vodDownload: overrides.settings?.vodDownload ?? true,
      chatDownload: overrides.settings?.chatDownload ?? true,
    },
  };
}

const VALID_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

export function setupBaseEnv(vodPath?: string): void {
  Object.keys(process.env).forEach((key) => delete process.env[key]);
  process.env.REDIS_URL = 'redis://localhost';
  process.env.META_DATABASE_URL = 'postgresql://meta';
  process.env.PGBOUNCER_URL = 'postgresql://bouncer';
  process.env.ENCRYPTION_MASTER_KEY = VALID_KEY;
  process.env.NODE_ENV = 'test';
  process.env.TWITCH_CLIENT_ID = 'test-twitch-client-id';
  process.env.TWITCH_CLIENT_SECRET = 'test-twitch-client-secret';
  process.env.YOUTUBE_CLIENT_ID = 'test-youtube-client-id';
  process.env.YOUTUBE_CLIENT_SECRET = 'test-youtube-client-secret';
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
