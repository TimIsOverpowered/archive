import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { createMockRedis } from '../helpers/mock-redis.js';

describe('Integration: Mock Redis', () => {
  let mock: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mock = createMockRedis();
  });

  it('should get/set values', async () => {
    await mock.connect();
    await mock.set('key1', 'value1', 'EX', 60);
    const val = await mock.get('key1');
    assert.strictEqual(val, 'value1');
  });

  it('should return null for missing keys', async () => {
    const val = await mock.get('nonexistent');
    assert.strictEqual(val, null);
  });

  it('should increment values', async () => {
    await mock.set('counter', '0');
    const val = await mock.incr('counter');
    assert.strictEqual(val, 1);
  });

  it('should delete keys', async () => {
    await mock.set('delkey', 'value');
    const count = await mock.del('delkey');
    assert.strictEqual(count, 1);
    assert.strictEqual(await mock.get('delkey'), null);
  });

  it('should support pipeline', async () => {
    const pipeline = mock.pipeline();
    pipeline.set('a', '1');
    pipeline.incr('b');
    const results = await pipeline.exec();
    assert.strictEqual(results[0], 'OK');
    assert.strictEqual(results[1], 1);
  });

  it('should support publish/subscribe', async () => {
    let received: string | null = null;
    mock.on('message', (ch: string, msg: string) => {
      received = msg;
    });
    await mock.subscribe('test-channel');
    await mock.publish('test-channel', 'hello');
    assert.strictEqual(received, 'hello');
  });

  it('should support duplicate for subscriber', async () => {
    await mock.connect();
    const dup = mock.duplicate();
    await dup.subscribe('ch');
    assert.ok(dup);
  });

  it('should reset all data', async () => {
    await mock.set('k1', 'v1');
    await mock.set('k2', 'v2');
    mock.reset();
    assert.strictEqual(await mock.get('k1'), null);
    assert.strictEqual(await mock.get('k2'), null);
  });
});
