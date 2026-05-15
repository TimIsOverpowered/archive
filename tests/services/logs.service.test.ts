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
  process.env.TMP_PATH = '/tmp/test-tmp';
  process.env.VOD_PATH = '/tmp/test-vods';
}

setupBaseEnv();

/**
 * Creates a mock DB that supports:
 * - VOD metadata return (first executeTakeFirst on 'vods' table)
 * - Queue of chat message results (one per bucket fetch via execute)
 * - Optional dead-air peek result (first executeTakeFirst on 'chat_messages' after all bucket fetches)
 */
function createMockDb(cfg: {
  /** VOD metadata. If undefined/null, VOD not found. */
  vodResult?: { created_at: Date; duration: number } | null;
  /** Queue of chat message arrays. Each execute() pops one from the front. */
  bucketQueue: (any[] | null)[];
  /** Optional result for dead-air peek query (executeTakeFirst on chat_messages after buckets exhausted) */
  peekResult?: any | null;
}): any {
  let bucketIndex = 0;
  let vodReturned = false;
  let peekReturned = false;

  function chainable(): any {
    return {
      where: () => chainable(),
      orderBy: () => ({
        orderBy: () => ({
          limit: () => ({
            execute: async () => {
              const result = cfg.bucketQueue[bucketIndex] ?? [];
              bucketIndex++;
              return result;
            },
            executeTakeFirst: async () => {
              if (!vodReturned) {
                vodReturned = true;
                return cfg.vodResult ?? null;
              }
              if (!peekReturned) {
                peekReturned = true;
                return cfg.peekResult ?? null;
              }
              return null;
            },
          }),
          execute: async () => {
            const result = cfg.bucketQueue[bucketIndex] ?? [];
            bucketIndex++;
            return result;
          },
          executeTakeFirst: async () => {
            if (!vodReturned) {
              vodReturned = true;
              return cfg.vodResult ?? null;
            }
            if (!peekReturned) {
              peekReturned = true;
              return cfg.peekResult ?? null;
            }
            return null;
          },
        }),
        limit: () => ({
          execute: async () => {
            const result = cfg.bucketQueue[bucketIndex] ?? [];
            bucketIndex++;
            return result;
          },
          executeTakeFirst: async () => {
            if (!vodReturned) {
              vodReturned = true;
              return cfg.vodResult ?? null;
            }
            if (!peekReturned) {
              peekReturned = true;
              return cfg.peekResult ?? null;
            }
            return null;
          },
        }),
        execute: async () => {
          const result = cfg.bucketQueue[bucketIndex] ?? [];
          bucketIndex++;
          return result;
        },
        executeTakeFirst: async () => {
          if (!vodReturned) {
            vodReturned = true;
            return cfg.vodResult ?? null;
          }
          if (!peekReturned) {
            peekReturned = true;
            return cfg.peekResult ?? null;
          }
          return null;
        },
      }),
      execute: async () => {
        const result = cfg.bucketQueue[bucketIndex] ?? [];
        bucketIndex++;
        return result;
      },
      executeTakeFirst: async () => {
        if (!vodReturned) {
          vodReturned = true;
          return cfg.vodResult ?? null;
        }
        if (!peekReturned) {
          peekReturned = true;
          return cfg.peekResult ?? null;
        }
        return null;
      },
    };
  }

  return {
    selectFrom: () => ({
      select: () => chainable(),
    }),
  };
}

describe('LogsService: getLogsByOffset', () => {
  let mockDb: any;
  let mockClient: any;
  let originalEnv: NodeJS.ProcessEnv;

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
    const neverResolveDb = createMockDb({
      vodResult: null,
      bucketQueue: [],
    });

    try {
      await getLogsByOffset(neverResolveDb, 'tenant-1', 999, 0);
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(error.message.startsWith('VOD not found'));
    }
  });

  it('should return empty comments when no chat messages found', async () => {
    mockDb = createMockDb({
      vodResult: {
        created_at: new Date('2024-01-01T00:00:00Z'),
        duration: 3600,
      },
      bucketQueue: [
        [], // anchor bucket (0-60)
        [], // backward expansion -1
        [], // backward expansion -2
        [], // backward expansion -3
        [], // backward expansion -4
        [], // forward expansion +1
        [], // forward expansion +2
        [], // forward expansion +3
        [], // forward expansion +4
        null, // dead air peek
      ],
    });

    const result = await getLogsByOffset(mockDb, 'tenant-1', 1, 30);
    assert.strictEqual(result.comments.length, 0);
    assert.strictEqual(result.cursor, undefined);
  });

  it('should return all comments from anchor bucket split at offset', async () => {
    const messages = [
      {
        id: 'msg-1',
        vod_id: 1,
        display_name: 'user1',
        content_offset_seconds: 10,
        user_color: '#FF0000',
        created_at: new Date('2024-01-01T00:00:10Z'),
        message: 'Before offset',
        user_badges: [],
      },
      {
        id: 'msg-2',
        vod_id: 1,
        display_name: 'user2',
        content_offset_seconds: 40,
        user_color: '#00FF00',
        created_at: new Date('2024-01-01T00:00:40Z'),
        message: 'After offset',
        user_badges: [],
      },
    ];

    mockDb = createMockDb({
      vodResult: {
        created_at: new Date('2024-01-01T00:00:00Z'),
        duration: 3600,
      },
      bucketQueue: [
        messages, // anchor bucket (0-60)
        [], // backward expansion (not needed if targets met)
      ],
    });

    const result = await getLogsByOffset(mockDb, 'tenant-1', 1, 25);
    assert.strictEqual(result.comments.length, 2);
    assert.strictEqual(result.comments[0]?.id, 'msg-1');
    assert.strictEqual(result.comments[1]?.id, 'msg-2');
  });

  it('should return 60-aligned cursor for next un-scanned bucket', async () => {
    const messages = [
      {
        id: 'msg-1',
        vod_id: 1,
        display_name: 'user1',
        content_offset_seconds: 10,
        user_color: '#FF0000',
        created_at: new Date('2024-01-01T00:00:10Z'),
        message: 'Hello',
        user_badges: [],
      },
    ];

    mockDb = createMockDb({
      vodResult: {
        created_at: new Date('2024-01-01T00:00:00Z'),
        duration: 3600,
      },
      bucketQueue: [
        messages, // anchor (0-60)
        [], // backward expansion (will expand until TARGET_PAST or MAX_EXPANSION)
        [],
        [],
        [],
        [],
        [],
        [],
        [],
      ],
      peekResult: {
        id: 'msg-next',
        content_offset_seconds: 310,
      },
    });

    const result = await getLogsByOffset(mockDb, 'tenant-1', 1, 30);
    assert.strictEqual(result.comments.length, 1);
    assert.ok(result.cursor);
    const decoded = JSON.parse(Buffer.from(result.cursor, 'base64').toString());
    assert.strictEqual(decoded.offset, 300);
  });

  it('should expand backward when past comments are below TARGET_PAST', async () => {
    const pastMessages = [
      {
        id: 'msg-past',
        vod_id: 1,
        display_name: 'user1',
        content_offset_seconds: 10,
        user_color: '#FF0000',
        created_at: new Date('2024-01-01T00:00:10Z'),
        message: 'Past',
        user_badges: [],
      },
    ];

    const futureMessages = [
      {
        id: 'msg-future',
        vod_id: 1,
        display_name: 'user2',
        content_offset_seconds: 50,
        user_color: '#00FF00',
        created_at: new Date('2024-01-01T00:00:50Z'),
        message: 'Future',
        user_badges: [],
      },
    ];

    const olderMessages = [
      {
        id: 'msg-older',
        vod_id: 1,
        display_name: 'user3',
        content_offset_seconds: 30,
        user_color: '#0000FF',
        created_at: new Date('2024-01-01T00:00:30Z'),
        message: 'Older',
        user_badges: [],
      },
    ];

    mockDb = createMockDb({
      vodResult: {
        created_at: new Date('2024-01-01T00:00:00Z'),
        duration: 3600,
      },
      bucketQueue: [
        [...pastMessages, ...futureMessages], // anchor (0-60)
        olderMessages, // backward -60 (will fetch since past < TARGET_PAST)
      ],
    });

    const result = await getLogsByOffset(mockDb, 'tenant-1', 1, 30);
    assert.ok(result.comments.length >= 2);
    assert.ok(result.comments.find((c) => c.id === 'msg-older'));
  });

  it('should fast-forward cursor during dead air via peek', async () => {
    const messages = [
      {
        id: 'msg-1',
        vod_id: 1,
        display_name: 'user1',
        content_offset_seconds: 10,
        user_color: '#FF0000',
        created_at: new Date('2024-01-01T00:00:10Z'),
        message: 'Only past message',
        user_badges: [],
      },
    ];

    const peekMsg = {
      id: 'msg-far',
      content_offset_seconds: 200,
    };

    mockDb = createMockDb({
      vodResult: {
        created_at: new Date('2024-01-01T00:00:00Z'),
        duration: 3600,
      },
      bucketQueue: [
        messages, // anchor (0-60) - all past, no future
        [], // backward -60
        [],
        [],
        [],
        [], // forward +60
        [], // forward +120
        [], // forward +180
        [], // forward +240
      ],
      peekResult: peekMsg,
    });

    const result = await getLogsByOffset(mockDb, 'tenant-1', 1, 30);
    assert.ok(result.cursor);
    const decoded = JSON.parse(Buffer.from(result.cursor, 'base64').toString());
    assert.strictEqual(decoded.offset, 180);
  });

  it('should break backward expansion at bucket < 0', async () => {
    const messages = [
      {
        id: 'msg-1',
        vod_id: 1,
        display_name: 'user1',
        content_offset_seconds: 5,
        user_color: '#FF0000',
        created_at: new Date('2024-01-01T00:00:05Z'),
        message: 'Early',
        user_badges: [],
      },
    ];

    mockDb = createMockDb({
      vodResult: {
        created_at: new Date('2024-01-01T00:00:00Z'),
        duration: 3600,
      },
      bucketQueue: [
        messages, // anchor (0-60)
        [], // backward -60 (skipped, < 0)
      ],
    });

    const result = await getLogsByOffset(mockDb, 'tenant-1', 1, 10);
    assert.strictEqual(result.comments.length, 1);
  });

  it('should return cached bucket result from Redis', async () => {
    const cachedComments = [
      {
        id: 'cached-msg',
        vod_id: 1,
        display_name: 'cached',
        content_offset_seconds: 10,
        user_color: '#FFF',
        created_at: new Date('2024-01-01T00:00:10Z'),
        message: 'Cached',
        user_badges: [],
      },
    ];
    const { compressData } = await import('../../src/utils/compression.js');
    const compressed = await compressData(cachedComments);

    const isolatedClient = {
      getBuffer: async (key: string) => {
        if (key === 'simple:{tenant-1}:1:bucket:0') return Buffer.from(compressed);
        return null;
      },
    };
    (RedisService as any)._instance = { client: isolatedClient };

    mockDb = createMockDb({
      vodResult: {
        created_at: new Date('2024-01-01T00:00:00Z'),
        duration: 3600,
      },
      bucketQueue: [],
    });

    const result = await getLogsByOffset(mockDb, 'tenant-1', 1, 30);
    assert.strictEqual(result.comments.length, 1);
    assert.strictEqual(result.comments[0]?.id, 'cached-msg');
  });

  it('should handle Redis read error gracefully and fall through to DB', async () => {
    mockClient.getBuffer = async () => {
      throw new Error('ECONNREFUSED');
    };

    mockDb = createMockDb({
      vodResult: {
        created_at: new Date('2024-01-01T00:00:00Z'),
        duration: 3600,
      },
      bucketQueue: [[], [], [], [], [], [], [], [], []],
    });

    const result = await getLogsByOffset(mockDb, 'tenant-1', 1, 30);
    assert.strictEqual(result.comments.length, 0);
  });

  it('should use correct bucket calculation based on offset', async () => {
    let capturedBucket: number | null = null;

    const countingDb = {
      selectFrom: (table: string) => ({
        select: () => ({
          where: function (...args: any[]) {
            if (
              table === 'chat_messages' &&
              typeof args[0] === 'string' &&
              args[0] === 'content_offset_seconds' &&
              args[1] === '>=' &&
              capturedBucket === null
            ) {
              capturedBucket = args[2];
            }
            return this;
          },
          orderBy: () => ({
            orderBy: () => ({
              limit: () => ({
                execute: async () => [],
                executeTakeFirst: async () => ({
                  created_at: new Date('2024-01-01T00:00:00Z'),
                  duration: 3600,
                }),
              }),
              execute: async () => [],
              executeTakeFirst: async () => ({
                created_at: new Date('2024-01-01T00:00:00Z'),
                duration: 3600,
              }),
            }),
            limit: () => ({
              execute: async () => [],
              executeTakeFirst: async () => ({
                created_at: new Date('2024-01-01T00:00:00Z'),
                duration: 3600,
              }),
            }),
            execute: async () => [],
            executeTakeFirst: async () => ({
              created_at: new Date('2024-01-01T00:00:00Z'),
              duration: 3600,
            }),
          }),
          execute: async () => [],
          executeTakeFirst: async () => ({
            created_at: new Date('2024-01-01T00:00:00Z'),
            duration: 3600,
          }),
        }),
      }),
    };

    await getLogsByOffset(countingDb as any, 'tenant-1', 1, 150);
    assert.ok(capturedBucket !== null);
    assert.strictEqual(capturedBucket, 120);
  });
});

describe('LogsService: getLogsByCursor', () => {
  let mockDb: any;
  let mockClient: any;
  let originalEnv: NodeJS.ProcessEnv;

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
    mockDb = createMockDb({
      vodResult: null,
      bucketQueue: [],
    });

    try {
      await getLogsByCursor(mockDb, 'tenant-1', 1, 'not-base64!!!');
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  });

  it('should throw bad request for cursor missing offset', async () => {
    mockDb = createMockDb({
      vodResult: null,
      bucketQueue: [],
    });

    const cursor = Buffer.from(JSON.stringify({ foo: 'bar' })).toString('base64');
    try {
      await getLogsByCursor(mockDb, 'tenant-1', 1, cursor);
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  });

  it('should accept cursor with extra fields', async () => {
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

    mockDb = createMockDb({
      vodResult: {
        created_at: new Date('2024-01-01T00:00:00Z'),
        duration: 3600,
      },
      bucketQueue: [
        messages, // anchor bucket (60-120)
        [], // backward
      ],
    });

    const result = await getLogsByCursor(mockDb, 'tenant-1', 1, cursor);
    assert.strictEqual(result.comments.length, 1);
    assert.strictEqual(result.comments[0]?.id, 'msg-2');
  });

  it('should throw when VOD not found', async () => {
    const cursor = Buffer.from(JSON.stringify({ offset: 100 })).toString('base64');

    const neverResolveDb = createMockDb({
      vodResult: null,
      bucketQueue: [],
    });

    try {
      await getLogsByCursor(neverResolveDb, 'tenant-1', 999, cursor);
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(error.message.startsWith('VOD not found'));
    }
  });

  it('should return empty comments when no messages in bucket', async () => {
    const cursor = Buffer.from(JSON.stringify({ offset: 100 })).toString('base64');

    mockDb = createMockDb({
      vodResult: {
        created_at: new Date('2024-01-01T00:00:00Z'),
        duration: 3600,
      },
      bucketQueue: [
        [], // anchor
        [], // backward
        [],
        [],
        [],
        [],
        [],
        [],
        [],
        null, // dead air peek
      ],
    });

    const result = await getLogsByCursor(mockDb, 'tenant-1', 1, cursor);
    assert.strictEqual(result.comments.length, 0);
    assert.strictEqual(result.cursor, undefined);
  });

  it('should share same bucket cache key as offset-based lookup', async () => {
    const cachedComments = [
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
    ];
    const { compressData } = await import('../../src/utils/compression.js');
    const compressed = await compressData(cachedComments);

    let cacheCallCount = 0;
    const isolatedClient = {
      getBuffer: async (key: string) => {
        if (key.includes(':bucket:')) {
          cacheCallCount++;
          if (cacheCallCount === 1) return Buffer.from(compressed);
        }
        return null;
      },
    };
    (RedisService as any)._instance = { client: isolatedClient };

    mockDb = createMockDb({
      vodResult: {
        created_at: new Date('2024-01-01T00:00:00Z'),
        duration: 3600,
      },
      bucketQueue: [],
    });

    const cursor = Buffer.from(JSON.stringify({ offset: 100 })).toString('base64');
    const result = await getLogsByCursor(mockDb, 'tenant-1', 1, cursor);
    assert.strictEqual(result.comments.length, 1);
    assert.strictEqual(result.comments[0]?.id, 'cached-msg');
  });

  it('should handle Redis read error gracefully and fall through to DB', async () => {
    mockClient.getBuffer = async () => {
      throw new Error('ECONNREFUSED');
    };

    mockDb = createMockDb({
      vodResult: {
        created_at: new Date('2024-01-01T00:00:00Z'),
        duration: 3600,
      },
      bucketQueue: [[], [], [], [], [], [], [], [], [], null],
    });

    const cursor = Buffer.from(JSON.stringify({ offset: 100 })).toString('base64');
    const result = await getLogsByCursor(mockDb, 'tenant-1', 1, cursor);
    assert.strictEqual(result.comments.length, 0);
  });
});
