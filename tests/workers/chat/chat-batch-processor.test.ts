import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { flushChatBatch } from '../../../src/workers/chat/chat-batch-processor.js';
import type { FlushBatchOptions, FlushBatchResult } from '../../../src/workers/chat/chat-batch-processor.js';
import type { ChatMessageCreateInput } from '../../../src/workers/chat/chat-types.js';

function createMockDb(): any {
  let insertCalls: any[] = [];
  let insertValue: any = { onConflict: () => ({ execute: async () => undefined }) };

  return {
    insertInto: (table: string) => {
      insertCalls.push({ table });
      return {
        values: (values: any[]) => {
          insertValue = { values, onConflict: () => ({ execute: async () => undefined }) };
          return insertValue;
        },
      };
    },
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          orderBy: () => ({
            executeTakeFirst: async () => null,
          }),
        }),
      }),
    }),
    updateTable: () => ({
      set: () => ({
        where: () => ({
          execute: async () => undefined,
        }),
      }),
    }),
    getInsertCalls: () => insertCalls,
    getInsertValue: () => insertValue,
  };
}

function createMockLog(): any {
  const calls: { level: string; ctx: any; msg: string }[] = [];
  return {
    debug: (ctx: any, msg?: string) => {
      calls.push({ level: 'debug', ctx, msg: msg || ctx });
    },
    info: (ctx: any, msg?: string) => {
      calls.push({ level: 'info', ctx, msg: msg || ctx });
    },
    warn: (ctx: any, msg?: string) => {
      calls.push({ level: 'warn', ctx, msg: msg || ctx });
    },
    error: (ctx: any, msg?: string) => {
      calls.push({ level: 'error', ctx, msg: msg || ctx });
    },
    getCalls: () => calls,
  };
}

function createMockMessage(override: Partial<ChatMessageCreateInput> = {}): ChatMessageCreateInput {
  return {
    id: 'msg-1',
    vod_id: 123,
    display_name: 'TestUser',
    content_offset_seconds: 10,
    createdAt: new Date('2024-01-15T20:00:00Z'),
    message: { content: 'hello', fragments: [] },
    user_badges: undefined,
    user_color: '#FF0000',
    ...override,
  };
}

describe('flushChatBatch', () => {
  it('should return early with no changes when buffer is empty', async () => {
    const db = createMockDb();
    const log = createMockLog();
    let onProgressCalled = false;

    const options: FlushBatchOptions = {
      db,
      buffer: [],
      log,
      vodId: 'vod-123',
      onProgress: () => {
        onProgressCalled = true;
      },
      lastOffset: 100,
      totalMessages: 50,
      batchCount: 5,
    };

    const result: FlushBatchResult = await flushChatBatch(options);

    assert.strictEqual(result.totalMessages, 50);
    assert.strictEqual(result.batchCount, 5);
    assert.strictEqual(onProgressCalled, false);
  });

  it('should insert messages into the database', async () => {
    const db = createMockDb();
    const log = createMockLog();
    const messages = [createMockMessage({ id: 'msg-1' }), createMockMessage({ id: 'msg-2' })];
    const options: FlushBatchOptions = {
      db,
      buffer: messages,
      log,
      vodId: 'vod-123',
      onProgress: () => {},
      lastOffset: 100,
      totalMessages: 50,
      batchCount: 5,
    };

    await flushChatBatch(options);

    const insertCalls = db.getInsertCalls();
    assert.strictEqual(insertCalls.length, 1);
    assert.strictEqual(insertCalls[0].table, 'chat_messages');
  });

  it('should update totalMessages and batchCount', async () => {
    const db = createMockDb();
    const log = createMockLog();

    const messages = [createMockMessage({ id: 'msg-1' })];
    const options: FlushBatchOptions = {
      db,
      buffer: messages,
      log,
      vodId: 'vod-123',
      onProgress: () => {},
      lastOffset: 100,
      totalMessages: 50,
      batchCount: 5,
    };

    const result: FlushBatchResult = await flushChatBatch(options);

    assert.strictEqual(result.totalMessages, 51);
    assert.strictEqual(result.batchCount, 6);
  });

  it('should call onProgress callback', async () => {
    const db = createMockDb();
    const log = createMockLog();
    let progressArgs: { offset: number; batchNumber: number; messagesInBatch: number } | null = null;

    const messages = [createMockMessage({ id: 'msg-1' })];
    const options: FlushBatchOptions = {
      db,
      buffer: messages,
      log,
      vodId: 'vod-123',
      onProgress: (offset, batchNumber, messagesInBatch) => {
        progressArgs = { offset, batchNumber, messagesInBatch };
      },
      lastOffset: 100,
      totalMessages: 50,
      batchCount: 5,
    };

    await flushChatBatch(options);

    assert.ok(progressArgs);
    const p = progressArgs as { offset: number; batchNumber: number; messagesInBatch: number };
    assert.strictEqual(p.offset, 100);
    assert.strictEqual(p.batchNumber, 6);
    assert.strictEqual(p.messagesInBatch, 1);
  });

  it('should clear the buffer after flushing', async () => {
    const db = createMockDb();
    const log = createMockLog();

    const messages = [createMockMessage({ id: 'msg-1' })];
    const options: FlushBatchOptions = {
      db,
      buffer: messages,
      log,
      vodId: 'vod-123',
      onProgress: () => {},
      lastOffset: 100,
      totalMessages: 50,
      batchCount: 5,
    };

    await flushChatBatch(options);

    assert.strictEqual(messages.length, 0);
  });

  it('should log debug message with batch details', async () => {
    const db = createMockDb();
    const log = createMockLog();

    const messages = [createMockMessage({ id: 'msg-1' }), createMockMessage({ id: 'msg-2' })];
    const options: FlushBatchOptions = {
      db,
      buffer: messages,
      log,
      vodId: 'vod-123',
      onProgress: () => {},
      lastOffset: 100,
      totalMessages: 50,
      batchCount: 5,
    };

    await flushChatBatch(options);

    const calls = log.getCalls();
    const debugCall = calls.find((c: any) => c.level === 'debug' && c.msg === 'Batch flushed to database');
    assert.ok(debugCall);
    assert.strictEqual(debugCall!.ctx.vodId, 'vod-123');
    assert.strictEqual(debugCall!.ctx.batchNumber, 6);
    assert.strictEqual(debugCall!.ctx.messagesInBatch, 2);
    assert.strictEqual(debugCall!.ctx.totalMessages, 52);
  });

  it('should convert message fields correctly for insert', async () => {
    const db = createMockDb();
    const log = createMockLog();

    const msg = createMockMessage({
      id: 'msg-1',
      display_name: 'TestUser',
      user_color: '#FF0000',
      message: { content: 'hello', fragments: [{ text: 'hello' }] },
      user_badges: [{ setID: 'mod' }],
    });
    const options: FlushBatchOptions = {
      db,
      buffer: [msg],
      log,
      vodId: 'vod-123',
      onProgress: () => {},
      lastOffset: 100,
      totalMessages: 50,
      batchCount: 5,
    };

    await flushChatBatch(options);

    const insertValue = db.getInsertValue();
    const inserted = insertValue.values[0];
    assert.strictEqual(inserted.id, 'msg-1');
    assert.strictEqual(inserted.vod_id, 123);
    assert.strictEqual(inserted.display_name, 'TestUser');
    assert.strictEqual(inserted.content_offset_seconds, 10);
    assert.strictEqual(inserted.user_color, '#FF0000');
    assert.ok(inserted.created_at);
    assert.strictEqual(inserted.message, JSON.stringify({ content: 'hello', fragments: [{ text: 'hello' }] }));
  });

  it('should handle null message and user_badges fields', async () => {
    const db = createMockDb();
    const log = createMockLog();

    const msg = createMockMessage({
      id: 'msg-1',
      message: null as any,
      user_badges: null as any,
    });
    const options: FlushBatchOptions = {
      db,
      buffer: [msg],
      log,
      vodId: 'vod-123',
      onProgress: () => {},
      lastOffset: 100,
      totalMessages: 50,
      batchCount: 5,
    };

    await flushChatBatch(options);

    const insertValue = db.getInsertValue();
    const inserted = insertValue.values[0];
    assert.strictEqual(inserted.message, null);
    assert.strictEqual(inserted.user_badges, null);
  });

  it('should handle large batch', async () => {
    const db = createMockDb();
    const log = createMockLog();

    const messages = Array.from({ length: 500 }, (_, i) => createMockMessage({ id: `msg-${i}` }));
    const options: FlushBatchOptions = {
      db,
      buffer: messages,
      log,
      vodId: 'vod-123',
      onProgress: () => {},
      lastOffset: 1000,
      totalMessages: 100,
      batchCount: 10,
    };

    const result: FlushBatchResult = await flushChatBatch(options);

    assert.strictEqual(result.totalMessages, 600);
    assert.strictEqual(result.batchCount, 11);
    assert.strictEqual(messages.length, 0);
  });

  it('should not call onProgress when buffer is empty', async () => {
    const db = createMockDb();
    const log = createMockLog();
    let onProgressCalled = false;

    const options: FlushBatchOptions = {
      db,
      buffer: [],
      log,
      vodId: 'vod-123',
      onProgress: () => {
        onProgressCalled = true;
      },
      lastOffset: 100,
      totalMessages: 50,
      batchCount: 5,
    };

    await flushChatBatch(options);
    assert.strictEqual(onProgressCalled, false);
  });
});
