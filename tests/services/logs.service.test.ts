import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { getLogsByOffset, getLogsByCursor } from '../../src/services/logs.service.js';
import { RedisService } from '../../src/utils/redis-service.js';
import { poolManager, resetClientManager } from '../../src/db/streamer-client.js';
import { resetEnvConfig } from '../../src/config/env.js';

const VALID_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function setupBaseEnv(): void {
  Object.keys(process.env).forEach((key) => delete process.env[key]);
  process.env.REDIS_URL = 'redis://localhost';
  process.env.META_DATABASE_URL = 'postgresql://meta';
  process.env.PGBOUNCER_URL = 'postgresql://bouncer';
  process.env.ENCRYPTION_MASTER_KEY = VALID_KEY;
  process.env.NODE_ENV = 'test';
}

setupBaseEnv();

describe('LogsService: getLogsByOffset', () => {
  let mockDb: any;
  let mockClient: any;
  let originalEnv: NodeJS.ProcessEnv;

  function chainableBuilder(
    executeResult: any,
    executeTakeFirstResult: any
  ): any {
    return {
      where: () => chainableBuilder(executeResult, executeTakeFirstResult),
      orderBy: () => ({
        orderBy: () => ({
          limit: () => ({
            execute: async () => executeResult,
            executeTakeFirst: async () => executeTakeFirstResult,
          }),
          execute: async () => executeResult,
          executeTakeFirst: async () => executeTakeFirstResult,
        }),
        execute: async () => executeResult,
        executeTakeFirst: async () => executeTakeFirstResult,
      }),
      execute: async () => executeResult,
      executeTakeFirst: async () => executeTakeFirstResult,
    };
  }

  function createMockDb(chatMessagesResult: any = [], vodResult: any = {
    created_at: new Date('2024-01-01T00:00:00Z'),
    duration: 3600,
  }): any {
    return {
      selectFrom: () => ({
        select: () => chainableBuilder(chatMessagesResult, vodResult),
      }),
    };
  }

  beforeEach(async () => {
    originalEnv = { ...process.env };

    mockClient = {
      get: async () => null,
      getBuffer: async () => null,
    };

    (RedisService as any)._instance = {
      client: mockClient,
    };

    resetEnvConfig();
    resetClientManager();
  });

  afterEach(async () => {
    Object.assign(process.env, originalEnv);
    (RedisService as any)._instance = null;
    mock.restoreAll();
    resetClientManager();
    resetEnvConfig();
  });

  it('should throw when VOD not found', async () => {
    const neverResolveDb = {
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            executeTakeFirst: async () => undefined,
            execute: async () => [],
          }),
        }),
      }),
    };

    try {
      await getLogsByOffset(neverResolveDb, 'tenant-1', 999, 0);
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok((error as Error).message.startsWith('VOD not found'));
    }
  });

  it('should return empty comments when no chat messages found', async () => {
    mockDb = createMockDb([], {
      created_at: new Date('2024-01-01T00:00:00Z'),
      duration: 3600,
    });

    const result = await getLogsByOffset(mockDb, 'tenant-1', 1, 0);
    assert.deepStrictEqual(result, { comments: [], cursor: undefined });
  });

  it('should return comments without cursor when fewer than page size + 1', async () => {
    const messages = [
      {
        id: 'msg-1',
        vod_id: 1,
        display_name: 'user1',
        content_offset_seconds: 0,
        user_color: '#FF0000',
        created_at: new Date('2024-01-01T00:00:00Z'),
        message: 'Hello!',
        user_badges: [],
      },
      {
        id: 'msg-2',
        vod_id: 1,
        display_name: 'user2',
        content_offset_seconds: 10,
        user_color: '#00FF00',
        created_at: new Date('2024-01-01T00:00:10Z'),
        message: 'Hi there!',
        user_badges: [],
      },
    ];

    mockDb = createMockDb(messages, {
      created_at: new Date('2024-01-01T00:00:00Z'),
      duration: 3600,
    });

    const result = await getLogsByOffset(mockDb, 'tenant-1', 1, 0);
    assert.strictEqual(result.comments.length, 2);
    assert.strictEqual(result.cursor, undefined);
    assert.strictEqual(result.comments[0].id, 'msg-1');
    assert.strictEqual(result.comments[1].id, 'msg-2');
  });

  it('should return cursor when there are more messages (page size + 1)', async () => {
    const { LOGS_PAGE_SIZE } = await import('../../src/constants.js');
    const messages: any[] = [];
    for (let i = 0; i <= LOGS_PAGE_SIZE; i++) {
      const totalSeconds = i * 10;
      const mins = Math.floor(totalSeconds / 60);
      const secs = totalSeconds % 60;
      messages.push({
        id: `msg-${i}`,
        vod_id: 1,
        display_name: `user${i}`,
        content_offset_seconds: totalSeconds,
        user_color: '#FFFFFF',
        created_at: new Date(`2024-01-01T00:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}Z`),
        message: `Message ${i}`,
        user_badges: [],
      });
    }

    mockDb = createMockDb(messages, {
      created_at: new Date('2024-01-01T00:00:00Z'),
      duration: 3600,
    });

    const result = await getLogsByOffset(mockDb, 'tenant-1', 1, 0);
    assert.strictEqual(result.comments.length, LOGS_PAGE_SIZE);
    assert.ok(result.cursor);
    assert.ok(typeof result.cursor === 'string');
    const decoded = JSON.parse(Buffer.from(result.cursor!, 'base64').toString());
    assert.ok(decoded.offset !== undefined);
    assert.ok(decoded.createdAt !== undefined);
    assert.ok(decoded.id !== undefined);
  });

  it('should return cached result when Redis has bucket data', async () => {
    const cachedData = {
      comments: [{ id: 'cached-msg', vod_id: 1, display_name: 'cached', content_offset_seconds: 0, user_color: '#FFF', created_at: new Date(), message: 'Cached', user_badges: [] }],
      cursor: 'cached-cursor',
    };
    const { compressChatData } = await import('../../src/utils/compression.js');
    const compressed = await compressChatData(cachedData);

    mockClient.getBuffer = async () => Buffer.from(compressed as Buffer);

    mockDb = createMockDb();

    const result = await getLogsByOffset(mockDb, 'tenant-1', 1, 0);
    assert.strictEqual(result.comments.length, 1);
    assert.strictEqual(result.comments[0].id, 'cached-msg');
    assert.strictEqual(result.cursor, 'cached-cursor');
  });

  it('should handle Redis read error gracefully and fall through to DB', async () => {
    mockClient.getBuffer = async () => {
      throw new Error('ECONNREFUSED');
    };

    mockDb = createMockDb([], {
      created_at: new Date('2024-01-01T00:00:00Z'),
      duration: 3600,
    });

    const result = await getLogsByOffset(mockDb, 'tenant-1', 1, 0);
    assert.deepStrictEqual(result, { comments: [], cursor: undefined });
  });

  it('should use correct bucket calculation based on offset', async () => {
    let capturedBucket: number | null = null;
    let whereCallIndex = 0;

    function countingBuilder(executeResult: any, executeTakeFirstResult: any): any {
      return {
        where: function (this: any, ...args: any[]) {
          whereCallIndex++;
          if (whereCallIndex === 4 && typeof args[0] === 'string' && args[0] === 'content_offset_seconds') {
            capturedBucket = args[2];
          }
          return countingBuilder(executeResult, executeTakeFirstResult);
        },
        orderBy: () => ({
          orderBy: () => ({
            limit: () => ({
              execute: async () => executeResult,
              executeTakeFirst: async () => executeTakeFirstResult,
            }),
            execute: async () => executeResult,
            executeTakeFirst: async () => executeTakeFirstResult,
          }),
          execute: async () => executeResult,
          executeTakeFirst: async () => executeTakeFirstResult,
        }),
        execute: async () => executeResult,
        executeTakeFirst: async () => executeTakeFirstResult,
      };
    }

    mockDb = {
      selectFrom: () => ({
        select: () => countingBuilder([], {
          created_at: new Date('2024-01-01T00:00:00Z'),
          duration: 3600,
        }),
      }),
    };

    await getLogsByOffset(mockDb, 'tenant-1', 1, 150);
    assert.ok(capturedBucket !== null);
    assert.ok(capturedBucket >= 0);
  });
});

describe('LogsService: getLogsByCursor', () => {
  let mockDb: any;
  let mockClient: any;
  let originalEnv: NodeJS.ProcessEnv;

  function chainableBuilder(
    executeResult: any,
    executeTakeFirstResult: any
  ): any {
    return {
      where: () => chainableBuilder(executeResult, executeTakeFirstResult),
      orderBy: () => ({
        orderBy: () => ({
          limit: () => ({
            execute: async () => executeResult,
            executeTakeFirst: async () => executeTakeFirstResult,
          }),
          execute: async () => executeResult,
          executeTakeFirst: async () => executeTakeFirstResult,
        }),
        execute: async () => executeResult,
        executeTakeFirst: async () => executeTakeFirstResult,
      }),
      execute: async () => executeResult,
      executeTakeFirst: async () => executeTakeFirstResult,
    };
  }

  function createMockDb(chatMessagesResult: any = [], vodResult: any = {
    created_at: new Date('2024-01-01T00:00:00Z'),
    duration: 3600,
  }): any {
    return {
      selectFrom: () => ({
        select: () => chainableBuilder(chatMessagesResult, vodResult),
      }),
    };
  }

  beforeEach(async () => {
    originalEnv = { ...process.env };

    mockClient = {
      get: async () => null,
      getBuffer: async () => null,
    };

    (RedisService as any)._instance = {
      client: mockClient,
    };

    resetEnvConfig();
    resetClientManager();
  });

  afterEach(async () => {
    Object.assign(process.env, originalEnv);
    (RedisService as any)._instance = null;
    mock.restoreAll();
    resetClientManager();
    resetEnvConfig();
  });

  it('should throw bad request for invalid cursor format', async () => {
    mockDb = createMockDb();

    try {
      await getLogsByCursor(mockDb, 'tenant-1', 1, 'not-base64!!!');
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  });

  it('should throw bad request for cursor missing required fields', async () => {
    mockDb = createMockDb();

    const cursor = Buffer.from(JSON.stringify({ offset: 100 })).toString('base64');
    try {
      await getLogsByCursor(mockDb, 'tenant-1', 1, cursor);
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  });

  it('should throw bad request for cursor with invalid date', async () => {
    mockDb = createMockDb();

    const cursor = Buffer.from(JSON.stringify({
      offset: 100,
      createdAt: 'not-a-date',
      id: 'msg-1',
    })).toString('base64');
    try {
      await getLogsByCursor(mockDb, 'tenant-1', 1, cursor);
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  });

  it('should throw when VOD not found', async () => {
    const cursor = Buffer.from(JSON.stringify({
      offset: 100,
      createdAt: new Date().toISOString(),
      id: 'msg-1',
    })).toString('base64');

    const neverResolveDb = {
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            executeTakeFirst: async () => undefined,
            execute: async () => [],
          }),
        }),
      }),
    };

    try {
      await getLogsByCursor(neverResolveDb, 'tenant-1', 999, cursor);
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok((error as Error).message.startsWith('VOD not found'));
    }
  });

  it('should return empty comments when no messages after cursor', async () => {
    const cursor = Buffer.from(JSON.stringify({
      offset: 100,
      createdAt: new Date().toISOString(),
      id: 'msg-1',
    })).toString('base64');

    mockDb = createMockDb([], {
      created_at: new Date('2024-01-01T00:00:00Z'),
      duration: 3600,
    });

    const result = await getLogsByCursor(mockDb, 'tenant-1', 1, cursor);
    assert.deepStrictEqual(result, { comments: [], cursor: undefined });
  });

  it('should return comments with next cursor when paginated', async () => {
    const { LOGS_PAGE_SIZE } = await import('../../src/constants.js');
    const messages: any[] = [];
    for (let i = 0; i <= LOGS_PAGE_SIZE; i++) {
      const totalSeconds = 60 + 10 + i * 10;
      const mins = Math.floor(totalSeconds / 60);
      const secs = totalSeconds % 60;
      messages.push({
        id: `msg-${i}`,
        vod_id: 1,
        display_name: `user${i}`,
        content_offset_seconds: 110 + i * 10,
        user_color: '#FFFFFF',
        created_at: new Date(`2024-01-01T00:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}Z`),
        message: `Message ${i}`,
        user_badges: [],
      });
    }

    mockDb = createMockDb(messages, {
      created_at: new Date('2024-01-01T00:00:00Z'),
      duration: 3600,
    });

    const cursor = Buffer.from(JSON.stringify({
      offset: 100,
      createdAt: new Date('2024-01-01T00:01:40Z').toISOString(),
      id: 'msg-9',
    })).toString('base64');

    const result = await getLogsByCursor(mockDb, 'tenant-1', 1, cursor);
    assert.strictEqual(result.comments.length, LOGS_PAGE_SIZE);
    assert.ok(result.cursor);
    const decoded = JSON.parse(Buffer.from(result.cursor!, 'base64').toString());
    assert.ok(decoded.offset !== undefined);
    assert.ok(decoded.createdAt !== undefined);
    assert.ok(decoded.id !== undefined);
  });

  it('should return cached result when Redis has cursor data', async () => {
    const cachedData = {
      comments: [{ id: 'cached-msg', vod_id: 1, display_name: 'cached', content_offset_seconds: 110, user_color: '#FFF', created_at: new Date(), message: 'Cached from cursor', user_badges: [] }],
      cursor: 'next-cursor',
    };
    const { compressChatData } = await import('../../src/utils/compression.js');
    const compressed = await compressChatData(cachedData);

    mockClient.getBuffer = async () => Buffer.from(compressed as Buffer);

    mockDb = createMockDb();

    const cursor = Buffer.from(JSON.stringify({
      offset: 100,
      createdAt: new Date().toISOString(),
      id: 'msg-1',
    })).toString('base64');

    const result = await getLogsByCursor(mockDb, 'tenant-1', 1, cursor);
    assert.strictEqual(result.comments.length, 1);
    assert.strictEqual(result.comments[0].id, 'cached-msg');
    assert.strictEqual(result.cursor, 'next-cursor');
  });

  it('should handle Redis read error gracefully and fall through to DB', async () => {
    mockClient.getBuffer = async () => {
      throw new Error('ECONNREFUSED');
    };

    mockDb = createMockDb([], {
      created_at: new Date('2024-01-01T00:00:00Z'),
      duration: 3600,
    });

    const cursor = Buffer.from(JSON.stringify({
      offset: 100,
      createdAt: new Date().toISOString(),
      id: 'msg-1',
    })).toString('base64');

    const result = await getLogsByCursor(mockDb, 'tenant-1', 1, cursor);
    assert.deepStrictEqual(result, { comments: [], cursor: undefined });
  });
});
