import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { resetEnvConfig } from '../../src/config/env.js';
import { resetClientManager } from '../../src/db/streamer-client.js';
import { getLogsByOffset, getLogsByCursor } from '../../src/services/logs.service.js';
import { RedisService } from '../../src/utils/redis-service.js';

const VALID_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function setupBaseEnv(): void {
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
}

setupBaseEnv();

describe('LogsService: getLogsByOffset', () => {
  let mockDb: any;
  let mockClient: any;
  let originalEnv: NodeJS.ProcessEnv;

  function createMockDb(
    chatMessagesResult: any = [],
    peekResult: any = null,
    vodResult: any = {
      created_at: new Date('2024-01-01T00:00:00Z'),
      duration: 3600,
    }
  ): any {
    let takeFirstCall = 0;

    function chainable(): any {
      return {
        where: () => chainable(),
        orderBy: () => ({
          orderBy: () => ({
            limit: () => ({
              execute: async () => chatMessagesResult,
              executeTakeFirst: async () => {
                takeFirstCall++;
                return takeFirstCall === 1 ? vodResult : peekResult;
              },
            }),
            execute: async () => chatMessagesResult,
            executeTakeFirst: async () => {
              takeFirstCall++;
              return takeFirstCall === 1 ? vodResult : peekResult;
            },
          }),
          execute: async () => chatMessagesResult,
          executeTakeFirst: async () => {
            takeFirstCall++;
            return takeFirstCall === 1 ? vodResult : peekResult;
          },
        }),
        execute: async () => chatMessagesResult,
        executeTakeFirst: async () => {
          takeFirstCall++;
          return takeFirstCall === 1 ? vodResult : peekResult;
        },
      };
    }

    return {
      selectFrom: () => ({
        select: () => chainable(),
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
      await getLogsByOffset(neverResolveDb as any, 'tenant-1', 999, 0);
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(error.message.startsWith('VOD not found'));
    }
  });

  it('should return empty comments when no chat messages found', async () => {
    mockDb = createMockDb([], null, {
      created_at: new Date('2024-01-01T00:00:00Z'),
      duration: 3600,
    });

    const result = await getLogsByOffset(mockDb, 'tenant-1', 1, 0);
    assert.deepStrictEqual(result, { comments: [], cursor: undefined });
  });

  it('should return full bucket without filtering by offset', async () => {
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

    mockDb = createMockDb(messages, null, {
      created_at: new Date('2024-01-01T00:00:00Z'),
      duration: 3600,
    });

    const result = await getLogsByOffset(mockDb, 'tenant-1', 1, 0);
    assert.strictEqual(result.comments.length, 2);
    assert.strictEqual(result.comments[0]?.id, 'msg-1');
    assert.strictEqual(result.comments[1]?.id, 'msg-2');
  });

  it('should return cursor when peek finds next bucket message', async () => {
    const messages = [
      {
        id: 'msg-1',
        vod_id: 1,
        display_name: 'user1',
        content_offset_seconds: 10,
        user_color: '#FF0000',
        created_at: new Date('2024-01-01T00:00:10Z'),
        message: 'Hello!',
        user_badges: [],
      },
    ];

    const peekMsg = {
      id: 'msg-next',
      content_offset_seconds: 65,
      created_at: new Date('2024-01-01T00:01:05Z'),
    };

    mockDb = createMockDb(messages, peekMsg, {
      created_at: new Date('2024-01-01T00:00:00Z'),
      duration: 3600,
    });

    const result = await getLogsByOffset(mockDb, 'tenant-1', 1, 0);
    assert.strictEqual(result.comments.length, 1);
    assert.ok(result.cursor);
    const decoded = JSON.parse(Buffer.from(result.cursor, 'base64').toString());
    assert.strictEqual(decoded.offset, 65);
  });

  it('should return no cursor when peek finds no next message', async () => {
    const messages = [
      {
        id: 'msg-1',
        vod_id: 1,
        display_name: 'user1',
        content_offset_seconds: 10,
        user_color: '#FF0000',
        created_at: new Date('2024-01-01T00:00:10Z'),
        message: 'Hello!',
        user_badges: [],
      },
    ];

    mockDb = createMockDb(messages, null, {
      created_at: new Date('2024-01-01T00:00:00Z'),
      duration: 3600,
    });

    const result = await getLogsByOffset(mockDb, 'tenant-1', 1, 0);
    assert.strictEqual(result.comments.length, 1);
    assert.strictEqual(result.cursor, undefined);
  });

  it('should return cached result when Redis has bucket data', async () => {
    const cachedData = {
      comments: [
        {
          id: 'cached-msg',
          vod_id: 1,
          display_name: 'cached',
          content_offset_seconds: 0,
          user_color: '#FFF',
          created_at: new Date(),
          message: 'Cached',
          user_badges: [],
        },
      ],
      cursor: 'cached-cursor',
    };
    const { compressData } = await import('../../src/utils/compression.js');
    const compressed = await compressData(cachedData);

    mockClient.getBuffer = async () => Buffer.from(compressed);

    mockDb = createMockDb();

    const result = await getLogsByOffset(mockDb, 'tenant-1', 1, 0);
    assert.strictEqual(result.comments.length, 1);
    assert.strictEqual(result.comments[0]?.id, 'cached-msg');
    assert.strictEqual(result.cursor, 'cached-cursor');
  });

  it('should handle Redis read error gracefully and fall through to DB', async () => {
    mockClient.getBuffer = async () => {
      throw new Error('ECONNREFUSED');
    };

    mockDb = createMockDb([], null, {
      created_at: new Date('2024-01-01T00:00:00Z'),
      duration: 3600,
    });

    const result = await getLogsByOffset(mockDb, 'tenant-1', 1, 0);
    assert.deepStrictEqual(result, { comments: [], cursor: undefined });
  });

  it('should use correct bucket calculation based on offset', async () => {
    let capturedBucket: number | null = null;
    let takeFirstCall = 0;

    function countingBuilder(): any {
      return {
        where: function (...args: any[]) {
          if (
            typeof args[0] === 'string' &&
            args[0] === 'content_offset_seconds' &&
            args[1] === '>=' &&
            capturedBucket === null
          ) {
            capturedBucket = args[2];
          }
          return countingBuilder();
        },
        orderBy: () => ({
          orderBy: () => ({
            limit: () => ({
              execute: async () => [],
              executeTakeFirst: async () => {
                takeFirstCall++;
                return takeFirstCall === 1 ? { created_at: new Date('2024-01-01T00:00:00Z'), duration: 3600 } : null;
              },
            }),
            execute: async () => [],
            executeTakeFirst: async () => {
              takeFirstCall++;
              return takeFirstCall === 1 ? { created_at: new Date('2024-01-01T00:00:00Z'), duration: 3600 } : null;
            },
          }),
          execute: async () => [],
          executeTakeFirst: async () => {
            takeFirstCall++;
            return takeFirstCall === 1 ? { created_at: new Date('2024-01-01T00:00:00Z'), duration: 3600 } : null;
          },
        }),
        execute: async () => [],
        executeTakeFirst: async () => {
          takeFirstCall++;
          return takeFirstCall === 1 ? { created_at: new Date('2024-01-01T00:00:00Z'), duration: 3600 } : null;
        },
      };
    }

    mockDb = {
      selectFrom: () => ({
        select: () => countingBuilder(),
      }),
    };

    await getLogsByOffset(mockDb, 'tenant-1', 1, 150);
    assert.ok(capturedBucket !== null);
    assert.strictEqual(capturedBucket, 120);
  });
});

describe('LogsService: getLogsByCursor', () => {
  let mockDb: any;
  let mockClient: any;
  let originalEnv: NodeJS.ProcessEnv;

  function createMockDb(
    chatMessagesResult: any = [],
    peekResult: any = null,
    vodResult: any = {
      created_at: new Date('2024-01-01T00:00:00Z'),
      duration: 3600,
    }
  ): any {
    let takeFirstCall = 0;

    function chainable(): any {
      return {
        where: () => chainable(),
        orderBy: () => ({
          orderBy: () => ({
            limit: () => ({
              execute: async () => chatMessagesResult,
              executeTakeFirst: async () => {
                takeFirstCall++;
                return takeFirstCall === 1 ? vodResult : peekResult;
              },
            }),
            execute: async () => chatMessagesResult,
            executeTakeFirst: async () => {
              takeFirstCall++;
              return takeFirstCall === 1 ? vodResult : peekResult;
            },
          }),
          execute: async () => chatMessagesResult,
          executeTakeFirst: async () => {
            takeFirstCall++;
            return takeFirstCall === 1 ? vodResult : peekResult;
          },
        }),
        execute: async () => chatMessagesResult,
        executeTakeFirst: async () => {
          takeFirstCall++;
          return takeFirstCall === 1 ? vodResult : peekResult;
        },
      };
    }

    return {
      selectFrom: () => ({
        select: () => chainable(),
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

  it('should throw bad request for cursor missing offset', async () => {
    mockDb = createMockDb();

    const cursor = Buffer.from(JSON.stringify({ foo: 'bar' })).toString('base64');
    try {
      await getLogsByCursor(mockDb, 'tenant-1', 1, cursor);
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  });

  it('should accept old cursor format with extra fields', async () => {
    const cursor = Buffer.from(
      JSON.stringify({
        offset: 100,
        createdAt: new Date().toISOString(),
        id: 'msg-1',
      })
    ).toString('base64');

    const messages = [
      {
        id: 'msg-2',
        vod_id: 1,
        display_name: 'user2',
        content_offset_seconds: 110,
        user_color: '#FFF',
        created_at: new Date('2024-01-01T00:01:50Z'),
        message: 'After cursor',
        user_badges: [],
      },
    ];

    mockDb = createMockDb(messages, null, {
      created_at: new Date('2024-01-01T00:00:00Z'),
      duration: 3600,
    });

    const result = await getLogsByCursor(mockDb, 'tenant-1', 1, cursor);
    assert.strictEqual(result.comments.length, 1);
    assert.strictEqual(result.comments[0]?.id, 'msg-2');
  });

  it('should throw when VOD not found', async () => {
    const cursor = Buffer.from(
      JSON.stringify({
        offset: 100,
      })
    ).toString('base64');

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
      await getLogsByCursor(neverResolveDb as any, 'tenant-1', 999, cursor);
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(error.message.startsWith('VOD not found'));
    }
  });

  it('should return empty comments when no messages in bucket', async () => {
    const cursor = Buffer.from(
      JSON.stringify({
        offset: 100,
      })
    ).toString('base64');

    mockDb = createMockDb([], null, {
      created_at: new Date('2024-01-01T00:00:00Z'),
      duration: 3600,
    });

    const result = await getLogsByCursor(mockDb, 'tenant-1', 1, cursor);
    assert.deepStrictEqual(result, { comments: [], cursor: undefined });
  });

  it('should share same bucket cache key as offset-based lookup', async () => {
    const cachedData = {
      comments: [
        {
          id: 'cached-msg',
          vod_id: 1,
          display_name: 'cached',
          content_offset_seconds: 110,
          user_color: '#FFF',
          created_at: new Date(),
          message: 'Cached from bucket',
          user_badges: [],
        },
      ],
      cursor: 'next-cursor',
    };
    const { compressData } = await import('../../src/utils/compression.js');
    const compressed = await compressData(cachedData);

    mockClient.getBuffer = async () => Buffer.from(compressed);

    mockDb = createMockDb();

    const cursor = Buffer.from(
      JSON.stringify({
        offset: 100,
      })
    ).toString('base64');

    const result = await getLogsByCursor(mockDb, 'tenant-1', 1, cursor);
    assert.strictEqual(result.comments.length, 1);
    assert.strictEqual(result.comments[0]?.id, 'cached-msg');
    assert.strictEqual(result.cursor, 'next-cursor');
  });

  it('should handle Redis read error gracefully and fall through to DB', async () => {
    mockClient.getBuffer = async () => {
      throw new Error('ECONNREFUSED');
    };

    mockDb = createMockDb([], null, {
      created_at: new Date('2024-01-01T00:00:00Z'),
      duration: 3600,
    });

    const cursor = Buffer.from(
      JSON.stringify({
        offset: 100,
      })
    ).toString('base64');

    const result = await getLogsByCursor(mockDb, 'tenant-1', 1, cursor);
    assert.deepStrictEqual(result, { comments: [], cursor: undefined });
  });
});
